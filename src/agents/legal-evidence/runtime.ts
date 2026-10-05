import path from "node:path";
import { readCheckedFile } from "./files.js";
import { bytesHash, evidenceHash, parseEvidenceJson } from "./hash.js";
import {
  materialInventoryHash,
  measureMaterialInventory,
  type MaterialInventory,
} from "./material.js";
import { assertEvidenceSchema } from "./schema.js";
import type { RuntimeIdentity } from "./types.js";

export type LegalEvidenceRuntimeReader = () => RuntimeIdentity;

/** A startup snapshot cannot certify material at a later send or seal boundary. */
export function readCurrentLegalEvidenceRuntime(reader: unknown): RuntimeIdentity {
  if (typeof reader !== "function") {
    throw new Error("legal-evidence-runtime-unavailable");
  }
  const runtime: unknown = reader();
  assertEvidenceSchema("RuntimeIdentity", runtime);
  return structuredClone(runtime) as RuntimeIdentity;
}

export function assertCurrentLegalEvidenceRuntime(
  reader: LegalEvidenceRuntimeReader,
  expected: RuntimeIdentity,
): void {
  if (evidenceHash(readCurrentLegalEvidenceRuntime(reader)) !== evidenceHash(expected)) {
    throw new Error("legal-evidence-runtime-drift");
  }
}

/** Server-only startup factory. The release must supply reviewed inventories and actual
 * loaded module paths; no RPC supplies pins, paths, or the identity reader. */
export function createLegalEvidenceRuntimeReader(options: {
  expected: RuntimeIdentity;
  engineRoot: string;
  engineInventory: MaterialInventory;
  adapterRoot: string;
  adapterInventory: MaterialInventory;
  patchFile: string;
  loadedEngineModules: string[];
  loadedAdapterModule: string;
  readIdentity: () => Pick<RuntimeIdentity, "installationId" | "rolePolicyHash">;
}): LegalEvidenceRuntimeReader {
  assertEvidenceSchema("RuntimeIdentity", options.expected);
  const { readIdentity } = options;
  if (typeof readIdentity !== "function") {
    throw new Error("legal-evidence-runtime-unavailable");
  }
  const config = structuredClone({ ...options, readIdentity: undefined });
  const { expected, engineInventory, adapterInventory } = config;
  const engineRoot = path.resolve(config.engineRoot),
    adapterRoot = path.resolve(config.adapterRoot);
  const patchFile = path.resolve(config.patchFile);
  function measuredModule(root: string, inventory: MaterialInventory, file: string): void {
    if (typeof file !== "string" || !path.isAbsolute(file)) {
      throw new Error("legal-evidence-loaded-module");
    }
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!inventory.files.some((entry) => entry.path === relative)) {
      throw new Error("legal-evidence-loaded-module");
    }
  }
  if (!Array.isArray(config.loadedEngineModules) || !config.loadedEngineModules.length) {
    throw new Error("legal-evidence-loaded-module");
  }
  for (const file of config.loadedEngineModules) {
    measuredModule(engineRoot, engineInventory, file);
  }
  measuredModule(adapterRoot, adapterInventory, config.loadedAdapterModule);
  return () => {
    const identity = readIdentity();
    if (
      identity.installationId !== expected.installationId ||
      identity.rolePolicyHash !== expected.rolePolicyHash
    ) {
      throw new Error("legal-evidence-runtime-drift");
    }
    const engine = measureMaterialInventory(engineRoot, engineInventory);
    const adapter = measureMaterialInventory(adapterRoot, adapterInventory);
    const pkg = parseEvidenceJson(
      readCheckedFile(path.join(adapterRoot, "package.json"), 1_000_000),
      1_000_000,
    ) as { name?: unknown; version?: unknown };
    if (
      pkg.name !== "@mariozechner/pi-ai" ||
      pkg.version !== "0.57.1" ||
      materialInventoryHash(engine, { engineRevision: expected.engineRevision }) !==
        expected.engineBuildHash ||
      materialInventoryHash(adapter, {
        package: "@mariozechner/pi-ai",
        packageVersion: "0.57.1",
      }) !== expected.adapterContentHash ||
      bytesHash(readCheckedFile(patchFile, 2_000_000)) !== expected.adapterPatchHash
    ) {
      throw new Error("legal-evidence-runtime-drift");
    }
    return structuredClone(expected);
  };
}
