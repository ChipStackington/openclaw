import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import fixtures from "./development-fixtures.json" with { type: "json" };
import { bytesHash } from "./hash.js";
import {
  createInstallationGuard,
  installationBuildHash,
  inventoryInstallation,
} from "./installation.js";
import { materialInventoryHash, type MaterialInventory } from "./material.js";
import { createLegalEvidenceRuntimeReader } from "./runtime.js";
import type { RuntimeIdentity } from "./types.js";

function fixture(
  cleanup: (callback: () => void) => void,
  kind: "engine" | "adapter" | "contained" | "equal",
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "legal-runtime-coverage-"));
  cleanup(() => fs.rmSync(home, { recursive: true, force: true }));
  const ancestor = path.join(home, "ancestor"),
    installationRoot = path.join(ancestor, "guarded");
  const engineRoot =
    kind === "engine"
      ? ancestor
      : kind === "equal"
        ? installationRoot
        : path.join(installationRoot, "engine");
  const adapterRoot = kind === "adapter" ? ancestor : path.join(installationRoot, "adapter");
  fs.mkdirSync(engineRoot, { recursive: true });
  fs.mkdirSync(adapterRoot, { recursive: true });
  const engineModule = path.join(installationRoot, "engine-entry.js"),
    adapterModule = path.join(installationRoot, "adapter-entry.js");
  // Both selected modules are guarded even when their inventory root is not.
  fs.writeFileSync(engineModule, "original engine");
  fs.writeFileSync(adapterModule, "original adapter");
  const loadedEngine =
    kind === "engine" || kind === "equal" ? engineModule : path.join(engineRoot, "entry.js");
  const loadedAdapter = kind === "adapter" ? adapterModule : path.join(adapterRoot, "index.js");
  fs.writeFileSync(loadedEngine, "original engine");
  fs.writeFileSync(loadedAdapter, "original adapter");
  fs.writeFileSync(
    path.join(adapterRoot, "package.json"),
    JSON.stringify({ name: "@mariozechner/pi-ai", version: "0.57.1" }),
  );
  const asset = path.join(
    kind === "engine" || kind === "adapter" ? ancestor : engineRoot,
    "asset.txt",
  );
  fs.writeFileSync(asset, "unloaded pinned asset");
  const patchFile = path.join(installationRoot, "adapter.patch");
  fs.writeFileSync(patchFile, "original patch");
  const inventory = (root: string): MaterialInventory => ({
    version: 1,
    files: fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const file = path.join(e.parentPath, e.name);
        return {
          path: path.relative(root, file).split(path.sep).join("/"),
          sha256: bytesHash(fs.readFileSync(file)),
        };
      })
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
  const engineInventory = inventory(engineRoot),
    adapterInventory = inventory(adapterRoot);
  const manifestFile = path.join(home, "manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(inventoryInstallation(installationRoot)));
  const manifestHash = bytesHash(fs.readFileSync(manifestFile));
  const installationGuard = createInstallationGuard({
    installationRoot,
    installationManifestFile: manifestFile,
    installationManifestHash: manifestHash,
  });
  const expected = structuredClone(fixtures.records.engine.record.runtime) as RuntimeIdentity;
  expected.engineBuildHash = installationBuildHash(
    engineInventory,
    expected.engineRevision,
    manifestHash,
  );
  expected.adapterContentHash = materialInventoryHash(adapterInventory, {
    package: "@mariozechner/pi-ai",
    packageVersion: "0.57.1",
  });
  expected.adapterPatchHash = bytesHash(fs.readFileSync(patchFile));
  return {
    asset,
    expected,
    options: {
      expected,
      installationGuard,
      engineRoot,
      engineInventory,
      adapterRoot,
      adapterInventory,
      patchFile,
      loadedEngineModules: [loadedEngine],
      loadedAdapterModule: loadedAdapter,
      readIdentity: () => expected,
    },
  };
}

for (const kind of ["engine", "adapter"] as const) {
  test(`construction rejects correctly pinned ${kind} inventory outside guard and holds permanently`, ({
    onTestFinished,
  }) => {
    const f = fixture(onTestFinished, kind);
    assert.throws(() => createLegalEvidenceRuntimeReader(f.options), /installation-drift/);
    assert.throws(f.options.installationGuard.verify, /installation-drift/);
  });
}
for (const kind of ["contained", "equal"] as const) {
  test(`valid ${kind} roots cover unloaded assets and permanently refuse drift`, ({
    onTestFinished,
  }) => {
    const f = fixture(onTestFinished, kind),
      read = createLegalEvidenceRuntimeReader(f.options);
    assert.deepEqual(read(), f.expected);
    const original = fs.readFileSync(f.asset);
    fs.writeFileSync(f.asset, "changed unloaded asset");
    assert.throws(read, /installation-drift/);
    fs.writeFileSync(f.asset, original);
    assert.throws(read, /installation-drift/);
  });
}
