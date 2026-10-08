import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { bytesHash } from "./hash.js";
import { createInstallationGuard, inventoryInstallation } from "./installation.js";
import { measureMaterialInventory } from "./material.js";

function fixture(cleanup: (f: () => void) => void) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "legal-installation-"));
  cleanup(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "immutable"),
    file = path.join(root, "node_modules/.pnpm/undici/index.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "DEVELOPMENT network dependency");
  const lazy = path.join(root, "node_modules/.pnpm/openai/responses.js");
  fs.mkdirSync(path.dirname(lazy), { recursive: true });
  fs.writeFileSync(lazy, "DEVELOPMENT never loaded provider branch");
  const native = path.join(root, "native.node");
  fs.writeFileSync(native, Buffer.from([0, 1, 2, 255]));
  const alias = path.join(root, "node_modules/undici");
  fs.symlinkSync(path.dirname(file), alias, process.platform === "win32" ? "junction" : "dir");
  const manifestFile = path.join(temp, "manifest.json");
  const manifest = inventoryInstallation(root);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const options = {
    installationRoot: root,
    installationManifestFile: manifestFile,
    installationManifestHash: bytesHash(fs.readFileSync(manifestFile)),
  };
  return { temp, root, file, lazy, native, alias, manifest, manifestFile, options };
}
test("healthy complete graph includes confined aliases, native assets and unexecuted provider branches", ({
  onTestFinished,
}) => {
  const f = fixture(onTestFinished),
    guard = createInstallationGuard(f.options);
  guard.verify();
  guard.verify();
  assert.equal(
    guard.assertFile(path.join(f.alias, "index.js")),
    bytesHash(fs.readFileSync(f.file)),
  );
  assert.ok(f.manifest.entries.some((e) => e.path.endsWith("responses.js")));
  assert.ok(f.manifest.entries.some((e) => e.path === "native.node"));
});
for (const mutation of [
  "network",
  "lazy",
  "native",
  "alias",
  "added",
  "deleted",
  "empty-dir",
  "manifest",
] as const) {
  test(`complete guard refuses ${mutation} drift and permanently holds after restoration`, ({
    onTestFinished,
  }) => {
    const f = fixture(onTestFinished),
      guard = createInstallationGuard(f.options);
    const original = fs.readFileSync(f.file);
    if (mutation === "network") {
      fs.appendFileSync(f.file, " changed");
    }
    if (mutation === "lazy") {
      fs.appendFileSync(f.lazy, " changed");
    }
    if (mutation === "native") {
      fs.appendFileSync(f.native, " changed");
    }
    if (mutation === "alias") {
      fs.unlinkSync(f.alias);
      fs.symlinkSync(
        path.dirname(f.lazy),
        f.alias,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    if (mutation === "added") {
      fs.writeFileSync(path.join(f.root, "new-provider.js"), "new");
    }
    if (mutation === "deleted") {
      fs.unlinkSync(f.lazy);
    }
    if (mutation === "empty-dir") {
      fs.mkdirSync(path.join(f.root, "unreviewed"));
    }
    if (mutation === "manifest") {
      fs.appendFileSync(f.manifestFile, " ");
    }
    assert.throws(guard.verify, /installation-drift/);
    if (mutation === "network") {
      fs.writeFileSync(f.file, original);
    }
    assert.throws(guard.verify, /installation-drift/);
    assert.throws(() => guard.assertFile(f.file), /installation-drift/);
  });
}
test("changing and restoring bytes between boundaries is refused by the process baseline", ({
  onTestFinished,
}) => {
  const f = fixture(onTestFinished),
    guard = createInstallationGuard(f.options),
    original = fs.readFileSync(f.file);
  fs.appendFileSync(f.file, " changed");
  fs.writeFileSync(f.file, original);
  assert.throws(guard.verify, /installation-drift/);
});
for (const unsafe of ["outside", "cycle", "hardlink", "root-alias"] as const) {
  test(`complete installation refuses ${unsafe} material`, ({ onTestFinished }) => {
    const f = fixture(onTestFinished);
    if (unsafe === "hardlink") {
      fs.linkSync(f.file, path.join(f.root, "hardlink.js"));
    }
    if (unsafe === "outside") {
      fs.symlinkSync(
        f.temp,
        path.join(f.root, "outside"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    if (unsafe === "cycle") {
      fs.symlinkSync(
        path.join(f.root, "cycle"),
        path.join(f.root, "cycle"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    if (unsafe === "root-alias") {
      const alias = path.join(f.temp, "aliased-root");
      fs.symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => inventoryInstallation(alias));
      return;
    }
    assert.throws(() => inventoryInstallation(f.root));
  });
}
test("unlisted load and invalid manifest pins cannot certify a module", ({ onTestFinished }) => {
  const f = fixture(onTestFinished),
    guard = createInstallationGuard(f.options);
  const outside = path.join(f.temp, "outside.js");
  fs.writeFileSync(outside, "unlisted");
  assert.throws(() => guard.assertFile(outside));
  assert.throws(() =>
    createInstallationGuard({ ...f.options, installationManifestHash: "0".repeat(64) }),
  );
});
test("the existing v1 material reader still refuses links and more than 20,000 files", ({
  onTestFinished,
}) => {
  const f = fixture(onTestFinished);
  assert.throws(() =>
    measureMaterialInventory(f.root, {
      version: 1,
      files: [{ path: "native.node", sha256: bytesHash(fs.readFileSync(f.native)) }],
    }),
  );
  assert.throws(() =>
    measureMaterialInventory(f.root, {
      version: 1,
      files: Array.from({ length: 20_001 }, (_, i) => ({ path: `f${i}`, sha256: "0".repeat(64) })),
    }),
  );
});

test("byte drift with the old modification time restored still fails the immutable baseline", ({
  onTestFinished,
}) => {
  const f = fixture(onTestFinished),
    guard = createInstallationGuard(f.options);
  const original = fs.statSync(f.file);
  fs.writeFileSync(f.file, "X".repeat(original.size));
  fs.utimesSync(f.file, original.atime, original.mtime);
  assert.throws(guard.verify, /installation-drift/);
});

test("large complete installation verifies unexecuted assets and refuses an incorrect last file pin", ({
  onTestFinished,
}) => {
  const f = fixture(onTestFinished);
  const assets = path.join(f.root, "assets");
  fs.mkdirSync(assets);
  for (let i = 0; i < 512; i++) {
    fs.writeFileSync(path.join(assets, i + ".bin"), Buffer.alloc(1024 + i, i % 256));
  }
  const manifest = inventoryInstallation(f.root);
  fs.writeFileSync(f.manifestFile, JSON.stringify(manifest));
  const options = {
    ...f.options,
    installationManifestHash: bytesHash(fs.readFileSync(f.manifestFile)),
  };
  const guard = createInstallationGuard(options);
  guard.verify();
  const last = manifest.entries.find((e) => e.path === "assets/511.bin");
  assert.ok(last?.kind === "file");
  last.sha256 = "0".repeat(64);
  fs.writeFileSync(f.manifestFile, JSON.stringify(manifest));
  assert.throws(
    () =>
      createInstallationGuard({
        ...options,
        installationManifestHash: bytesHash(fs.readFileSync(f.manifestFile)),
      }),
    /installation-drift/,
  );
  assert.throws(guard.verify, /installation-drift/);
});
