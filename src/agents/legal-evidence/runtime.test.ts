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
import {
  createLegalEvidenceRuntimeReader,
  readCurrentLegalEvidenceRuntime,
  readCurrentLegalEvidenceRuntimeAsync,
} from "./runtime.js";
import type { RuntimeIdentity } from "./types.js";

function setup(cleanup: (callback: () => void) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legal-astra-runtime-"));
  cleanup(() => fs.rmSync(root, { recursive: true, force: true }));
  const installationRoot = path.join(root, "installation");
  const engineRoot = path.join(installationRoot, "engine"),
    adapterRoot = path.join(installationRoot, "adapter");
  fs.mkdirSync(engineRoot, { recursive: true });
  fs.mkdirSync(adapterRoot);
  const engineModule = path.join(engineRoot, "DEVELOPMENT-capture.js");
  const adapterModule = path.join(adapterRoot, "DEVELOPMENT-provider.js");
  const patchFile = path.join(installationRoot, "DEVELOPMENT.patch");
  fs.writeFileSync(engineModule, "development capture fixture");
  fs.writeFileSync(adapterModule, "development provider fixture");
  fs.writeFileSync(
    path.join(adapterRoot, "package.json"),
    JSON.stringify({ name: "@mariozechner/pi-ai", version: "0.57.1" }),
  );
  fs.writeFileSync(patchFile, "development patch fixture");
  const inventory = (directory: string): MaterialInventory => ({
    version: 1,
    files: fs
      .readdirSync(directory)
      .toSorted()
      .map((file) => ({
        path: file,
        sha256: bytesHash(fs.readFileSync(path.join(directory, file))),
      })),
  });
  const engineInventory = inventory(engineRoot),
    adapterInventory = inventory(adapterRoot);
  const expected = structuredClone(fixtures.records.engine.record.runtime) as RuntimeIdentity;
  const installationManifestFile = path.join(root, "manifest.json");
  fs.writeFileSync(
    installationManifestFile,
    JSON.stringify(inventoryInstallation(installationRoot)),
  );
  const installationManifestHash = bytesHash(fs.readFileSync(installationManifestFile));
  const installationGuard = createInstallationGuard({
    installationRoot,
    installationManifestFile,
    installationManifestHash,
  });
  expected.engineBuildHash = installationBuildHash(
    engineInventory,
    expected.engineRevision,
    installationManifestHash,
  );
  expected.adapterContentHash = materialInventoryHash(adapterInventory, {
    package: "@mariozechner/pi-ai",
    packageVersion: "0.57.1",
  });
  expected.adapterPatchHash = bytesHash(fs.readFileSync(patchFile));
  const identity = {
    installationId: expected.installationId,
    rolePolicyHash: expected.rolePolicyHash,
  };
  const options = {
    expected,
    installationGuard,
    engineRoot,
    engineInventory,
    adapterRoot,
    adapterInventory,
    patchFile,
    loadedEngineModules: [engineModule],
    loadedAdapterModule: adapterModule,
    readIdentity: () => structuredClone(identity),
  };
  return { root, engineModule, adapterModule, patchFile, expected, identity, options };
}

test("runtime capability reads reviewed material again on every invocation", ({
  onTestFinished,
}) => {
  const f = setup(onTestFinished),
    read = createLegalEvidenceRuntimeReader(f.options);
  assert.deepEqual(read(), f.expected);
  assert.deepEqual(readCurrentLegalEvidenceRuntime(read), f.expected);
  fs.writeFileSync(f.adapterModule, "development bytes changed after initial capability");
  assert.throws(read, /drift/);
});

for (const drift of [
  "engine",
  "adapter",
  "patch",
  "unexpected",
  "missing",
  "installation",
  "role-policy",
] as const) {
  test(`current runtime reader refuses ${drift} material or identity drift`, ({
    onTestFinished,
  }) => {
    const f = setup(onTestFinished),
      read = createLegalEvidenceRuntimeReader(f.options);
    assert.deepEqual(read(), f.expected);
    if (drift === "engine") {
      fs.writeFileSync(f.engineModule, "changed engine fixture");
    }
    if (drift === "adapter") {
      fs.writeFileSync(f.adapterModule, "changed adapter fixture");
    }
    if (drift === "patch") {
      fs.writeFileSync(f.patchFile, "changed patch fixture");
    }
    if (drift === "unexpected") {
      fs.writeFileSync(path.join(f.options.engineRoot, "unexpected.js"), "extra");
    }
    if (drift === "missing") {
      fs.unlinkSync(f.adapterModule);
    }
    if (drift === "installation") {
      f.identity.installationId = "00000000-0000-4000-8000-000000000099";
    }
    if (drift === "role-policy") {
      f.identity.rolePolicyHash = "e".repeat(64);
    }
    assert.throws(read);
  });
}

test("runtime reader refuses an unmeasured loaded module even when inventory hashes match", ({
  onTestFinished,
}) => {
  const f = setup(onTestFinished),
    outside = path.join(f.root, "outside.js");
  fs.writeFileSync(outside, "unmeasured capture fixture");
  assert.throws(() =>
    createLegalEvidenceRuntimeReader({ ...f.options, loadedEngineModules: [outside] })(),
  );
  assert.throws(() =>
    createLegalEvidenceRuntimeReader({ ...f.options, loadedAdapterModule: outside })(),
  );
});

test("runtime reader snapshots server expectations and refuses mismatched inventory pins", ({
  onTestFinished,
}) => {
  const f = setup(onTestFinished),
    original = structuredClone(f.expected);
  const read = createLegalEvidenceRuntimeReader(f.options);
  f.expected.engineBuildHash = "a".repeat(64);
  f.options.engineInventory.files[0].sha256 = "b".repeat(64);
  assert.deepEqual(read(), original);
  assert.throws(() => createLegalEvidenceRuntimeReader(f.options)());
});

test("a cached object or asynchronous measurement cannot act as the synchronous runtime reader", () => {
  const runtime = fixtures.records.engine.record.runtime;
  assert.throws(() => readCurrentLegalEvidenceRuntime(runtime));
  assert.throws(() => readCurrentLegalEvidenceRuntime(async () => runtime));
});

test("reader construction refuses mismatched material pins before publishing a reader", ({
  onTestFinished,
}) => {
  const f = setup(onTestFinished);
  f.options.engineInventory.files[0].sha256 = "f".repeat(64);
  assert.throws(() => createLegalEvidenceRuntimeReader(f.options), /drift/);
});

test("reader construction enforces the strict v1 inventory file limit before publishing", ({
  onTestFinished,
}) => {
  const f = setup(onTestFinished);
  f.options.engineInventory.files = [
    f.options.engineInventory.files[0],
    ...Array.from({ length: 20000 }, (_, i) => ({ path: `f${i}`, sha256: "f".repeat(64) })),
  ];
  assert.throws(() => createLegalEvidenceRuntimeReader(f.options), /inventory-invalid/);
});

test("awaited runtime boundaries use the complete guard and remain revoked after drift", async ({
  onTestFinished,
}) => {
  const f = setup(onTestFinished);
  let calls = 0;
  const original = f.options.installationGuard;
  const read = createLegalEvidenceRuntimeReader({
    ...f.options,
    installationGuard: {
      ...original,
      verifyAsync: async () => {
        calls++;
        await original.verifyAsync();
      },
    },
  });
  assert.deepEqual(await readCurrentLegalEvidenceRuntimeAsync(read), f.expected);
  assert.equal(calls, 1);
  fs.writeFileSync(f.adapterModule, "changed while gateway running");
  await assert.rejects(readCurrentLegalEvidenceRuntimeAsync(read), /installation-drift/);
  await assert.rejects(readCurrentLegalEvidenceRuntimeAsync(read), /installation-drift/);
});
test("an async reader still validates its result and rejects a bare cached identity", async () => {
  const runtime = fixtures.records.engine.record.runtime;
  await assert.rejects(readCurrentLegalEvidenceRuntimeAsync(runtime));
  await assert.rejects(
    readCurrentLegalEvidenceRuntimeAsync(
      Object.assign(() => runtime, { readAsync: async () => ({}) }),
    ),
  );
});
