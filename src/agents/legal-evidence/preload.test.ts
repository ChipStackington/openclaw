import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { test } from "vitest";
import { bytesHash } from "./hash.js";
import { inventoryInstallation } from "./installation.js";
import { readLegalEvidencePreload } from "./preload-state.js";

function fixture(cleanup: (f: () => void) => void, main: string) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "legal-preload-"));
  cleanup(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "immutable");
  fs.mkdirSync(root);
  const preload = path.join(root, "preload.js"),
    entry = path.join(root, "main.js");
  buildSync({
    entryPoints: [fileURLToPath(new URL("./preload.ts", import.meta.url))],
    outfile: preload,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
  });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "lazy.js"), 'export default "healthy-lazy";');
  fs.writeFileSync(path.join(root, "common.cjs"), 'module.exports = "healthy-common";');
  fs.writeFileSync(path.join(root, "data.json"), '{"value":"healthy-json"}');
  fs.writeFileSync(entry, main);
  const manifestFile = path.join(temp, "manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(inventoryInstallation(root)));
  const configFile = path.join(temp, "startup.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      version: 2,
      installationRoot: root,
      installationManifestFile: manifestFile,
      installationManifestHash: bytesHash(fs.readFileSync(manifestFile)),
    }),
  );
  const run = (preloaded = true, disableCache = "1") =>
    spawnSync(
      process.execPath,
      [...(preloaded ? ["--import", pathToFileURL(preload).href] : []), entry],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          NODE_DISABLE_COMPILE_CACHE: disableCache,
          OPENCLAW_LEGAL_EVIDENCE_STARTUP_FILE: configFile,
        },
      },
    );
  return { root, configFile, run };
}
test("production preload is mandatory; no cached startup identity can supply it", () => {
  assert.throws(
    () => readLegalEvidencePreload("missing", "0".repeat(64), "missing", "0".repeat(64)),
    /preload-required/,
  );
});
test("actual Node preload permits pinned ESM/CommonJS/JSON and an unexecuted lazy branch", ({
  onTestFinished,
}) => {
  const f = fixture(
    onTestFinished,
    `import common from './common.cjs';
    import data from './data.json' with {type:'json'};
    const lazy = await import('./lazy.js');
    try { await import('./absent-optional.js'); } catch {}
    globalThis[Symbol.for('openclaw.legal-evidence.installation-preload.v1')].guard.verify();
    console.log(common, data.value, lazy.default);`,
  );
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /healthy-common healthy-json healthy-lazy/);
});
for (const mutation of ["loaded-byte", "outside", "capability"] as const) {
  test(`actual Node preload refuses ${mutation} after initial verification`, ({
    onTestFinished,
  }) => {
    const main =
      mutation === "loaded-byte"
        ? `import fs from 'node:fs';
      fs.appendFileSync(new URL('./lazy.js',import.meta.url),'// harmless changed bytes');
      await import('./lazy.js');`
        : mutation === "outside"
          ? `await import('../outside.js');`
          : `import fs from 'node:fs'; fs.appendFileSync(new URL('./lazy.js',import.meta.url),'// changed');
      globalThis[Symbol.for('openclaw.legal-evidence.installation-preload.v1')].guard.verify();`;
    const f = fixture(onTestFinished, main);
    if (mutation === "outside") {
      fs.writeFileSync(path.join(path.dirname(f.root), "outside.js"), "export default 1;");
    }
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legal-evidence-installation/);
  });
}

test("actual preload refuses a launcher that permits unmeasured compile cache", ({
  onTestFinished,
}) => {
  const f = fixture(onTestFinished, "console.log('must not execute');");
  const result = f.run(true, "0");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preload-required/);
  assert.doesNotMatch(result.stdout, /must not execute/);
});

test("actual CLI bootstrap refuses configured launch before any dist import without preload", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../../../openclaw.mjs", import.meta.url)), "--version"],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        OPENCLAW_LEGAL_EVIDENCE_STARTUP_FILE: "DEVELOPMENT missing config",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preload-required/);
});
