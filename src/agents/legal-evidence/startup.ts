import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCheckedFile } from "./files.js";
import { bytesHash, evidenceHash, parseEvidenceJson } from "./hash.js";
import type { MaterialInventory } from "./material.js";
import { createLegalEvidenceRuntimeReader, type LegalEvidenceRuntimeReader } from "./runtime.js";
import { assertEvidenceSchema } from "./schema.js";
import type { RuntimeIdentity } from "./types.js";

export const legalEvidenceStartupModuleUrl = import.meta.url;

export type LegalEvidenceStartupConfig = {
  version: 1;
  expected: RuntimeIdentity;
  engineRoot: string;
  engineInventory: MaterialInventory;
  adapterRoot: string;
  adapterInventory: MaterialInventory;
  patchFile: string;
  installationFile: string;
};

function exactObject(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== keys.toSorted().join(",")
  ) {
    throw new Error("legal-evidence-startup-config");
  }
}

function absolutePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("legal-evidence-startup-path");
  }
}

/** This file configures measurement, never approval. Independent app registry approval
 * remains required. Only startup supplies actual module URLs; RPC cannot supply paths. */
export function readLegalEvidenceStartup(options: {
  configFile: string | undefined;
  engineModuleUrls: string[];
  readAdapterModuleUrl: () => string;
  readAgents: () => unknown;
  readConfigFile?: () => string | undefined;
}): LegalEvidenceRuntimeReader | undefined {
  if (options.configFile === undefined) {
    return undefined;
  }
  absolutePath(options.configFile);
  const configFile = options.configFile;
  const configBytes = readCheckedFile(configFile, 4_000_000);
  const value = parseEvidenceJson(configBytes, 4_000_000);
  exactObject(value, [
    "version",
    "expected",
    "engineRoot",
    "engineInventory",
    "adapterRoot",
    "adapterInventory",
    "patchFile",
    "installationFile",
  ]);
  if (value.version !== 1) {
    throw new Error("legal-evidence-startup-config");
  }
  assertEvidenceSchema("RuntimeIdentity", value.expected);
  for (const key of ["engineRoot", "adapterRoot", "patchFile", "installationFile"]) {
    absolutePath(value[key]);
  }
  const config = value as unknown as LegalEvidenceStartupConfig;
  const loadedEngineModules = options.engineModuleUrls.map((url) => {
    const file = fileURLToPath(url);
    // A TypeScript development checkout cannot represent a compiled release.
    if (path.extname(file) !== ".js") {
      throw new Error("legal-evidence-startup-compiled-module");
    }
    return file;
  });
  const loadedAdapterModule = fileURLToPath(options.readAdapterModuleUrl());
  if (
    path.relative(config.adapterRoot, loadedAdapterModule).split(path.sep).join("/") !==
    "dist/index.js"
  ) {
    throw new Error("legal-evidence-startup-adapter-module");
  }
  for (const file of [
    "dist/providers/openai-codex-responses.js",
    "dist/providers/legal-evidence-sse.js",
  ]) {
    if (!config.adapterInventory.files.some((entry) => entry.path === file)) {
      throw new Error("legal-evidence-startup-adapter-module");
    }
  }
  const configHash = bytesHash(configBytes);
  const read = createLegalEvidenceRuntimeReader({
    ...config,
    loadedEngineModules,
    loadedAdapterModule,
    readIdentity: () => {
      if (
        (options.readConfigFile && options.readConfigFile() !== configFile) ||
        bytesHash(readCheckedFile(configFile, 4_000_000)) !== configHash
      ) {
        throw new Error("legal-evidence-runtime-drift");
      }
      const identity = parseEvidenceJson(readCheckedFile(config.installationFile, 4096), 4096);
      exactObject(identity, ["version", "installationId"]);
      if (identity.version !== 1) {
        throw new Error("legal-evidence-startup-installation");
      }
      assertEvidenceSchema("Uuid", identity.installationId);
      return {
        installationId: identity.installationId as string,
        rolePolicyHash: evidenceHash({ version: 1, agents: options.readAgents() ?? null }),
      };
    },
  });
  // Invalid enabled startup aborts before any gateway listener or background service.
  read();
  return read;
}
