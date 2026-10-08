import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import fixtures from "./development-fixtures.json" with { type: "json" };
import { bytesHash, evidenceHash } from "./hash.js";
import { materialInventoryHash, type MaterialInventory } from "./material.js";
import { readLegalEvidenceStartup } from "./startup.js";
import type { RuntimeIdentity } from "./types.js";
function fixture(cleanup: (callback: () => void) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legal-startup-development-"));
  cleanup(() => fs.rmSync(root, { recursive: true, force: true }));
  const engineRoot = path.join(root, "dist"),
    adapterRoot = path.join(root, "adapter");
  fs.mkdirSync(engineRoot);
  fs.mkdirSync(path.join(adapterRoot, "dist", "providers"), { recursive: true });
  const engineModule = path.join(engineRoot, "gateway.js");
  fs.writeFileSync(engineModule, "DEVELOPMENT compiled gateway");
  const adapterModule = path.join(adapterRoot, "dist", "index.js");
  fs.writeFileSync(adapterModule, "DEVELOPMENT adapter entry");
  for (const file of ["openai-codex-responses.js", "legal-evidence-sse.js"]) {
    fs.writeFileSync(path.join(adapterRoot, "dist", "providers", file), "DEVELOPMENT provider");
  }
  fs.writeFileSync(
    path.join(adapterRoot, "package.json"),
    JSON.stringify({ name: "@mariozechner/pi-ai", version: "0.57.1" }),
  );
  const inventory = (directory: string, relative = ""): MaterialInventory => ({
    version: 1,
    files: fs
      .readdirSync(directory)
      .flatMap((name) => {
        const file = path.join(directory, name),
          rel = relative ? relative + "/" + name : name;
        return fs.statSync(file).isDirectory()
          ? inventory(file, rel).files
          : [{ path: rel, sha256: bytesHash(fs.readFileSync(file)) }];
      })
      .toSorted((a, b) => (a.path < b.path ? -1 : 1)),
  });
  const engineInventory = inventory(engineRoot),
    adapterInventory = inventory(adapterRoot);
  const expected = structuredClone(fixtures.records.engine.record.runtime) as RuntimeIdentity;
  let agents: unknown = { defaults: { model: { primary: "DEVELOPMENT", fallbacks: [] } } };
  expected.rolePolicyHash = evidenceHash({ version: 1, agents });
  expected.engineBuildHash = materialInventoryHash(engineInventory, {
    engineRevision: expected.engineRevision,
  });
  expected.adapterContentHash = materialInventoryHash(adapterInventory, {
    package: "@mariozechner/pi-ai",
    packageVersion: "0.57.1",
  });
  const patchFile = path.join(root, "DEVELOPMENT.patch"),
    installationFile = path.join(root, "installation.json"),
    configFile = path.join(root, "startup.json");
  fs.writeFileSync(patchFile, "DEVELOPMENT patch");
  expected.adapterPatchHash = bytesHash(fs.readFileSync(patchFile));
  fs.writeFileSync(
    installationFile,
    JSON.stringify({ version: 1, installationId: expected.installationId }),
  );
  const config = {
    version: 1,
    expected,
    engineRoot,
    engineInventory,
    adapterRoot,
    adapterInventory,
    patchFile,
    installationFile,
  };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const options = {
    configFile,
    engineModuleUrls: [pathToFileURL(engineModule).href],
    readAdapterModuleUrl: () => pathToFileURL(adapterModule).href,
    readAgents: () => agents,
  };
  return {
    root,
    engineRoot,
    engineModule,
    adapterModule,
    configFile,
    installationFile,
    config,
    options,
    expected,
    setAgents: (value: unknown) => {
      agents = value;
    },
  };
}
test("disabled startup does not inspect files, modules, or role settings", () => {
  assert.equal(
    readLegalEvidenceStartup({
      configFile: undefined,
      engineModuleUrls: [],
      readAdapterModuleUrl: () => {
        throw Error("must not resolve");
      },
      readAgents: () => {
        throw Error("must not read");
      },
    }),
    undefined,
  );
});
test("configured startup returns current capability and refuses live role drift", ({
  onTestFinished,
}) => {
  const f = fixture(onTestFinished),
    read = readLegalEvidenceStartup(f.options)!;
  assert.deepEqual(read(), f.expected);
  f.setAgents({ defaults: { model: { primary: "CHANGED" } } });
  assert.throws(read, /drift/);
});
for (const mutation of ["config", "installation", "module", "adapter", "unexpected"] as const) {
  test(`startup capability refuses ${mutation} change after initial measurement`, ({
    onTestFinished,
  }) => {
    const f = fixture(onTestFinished),
      read = readLegalEvidenceStartup(f.options)!;
    if (mutation === "config") {
      fs.appendFileSync(f.configFile, " ");
    }
    if (mutation === "installation") {
      fs.writeFileSync(
        f.installationFile,
        JSON.stringify({ version: 1, installationId: "00000000-0000-4000-8000-000000000099" }),
      );
    }
    if (mutation === "module") {
      fs.writeFileSync(f.engineModule, "changed");
    }
    if (mutation === "adapter") {
      fs.writeFileSync(f.adapterModule, "changed");
    }
    if (mutation === "unexpected") {
      fs.writeFileSync(path.join(f.engineRoot, "extra.js"), "extra");
    }
    assert.throws(read);
  });
}
for (const bad of [
  "relative",
  "empty",
  "unknown",
  "duplicate",
  "source",
  "outside",
  "bad-pin",
  "installation-claim",
] as const) {
  test(`configured startup refuses ${bad} before capability publication`, ({ onTestFinished }) => {
    const f = fixture(onTestFinished);
    if (bad === "relative") {
      f.options.configFile = "startup.json";
    }
    if (bad === "empty") {
      f.options.configFile = "";
    }
    if (bad === "unknown") {
      fs.writeFileSync(f.configFile, JSON.stringify({ ...f.config, approved: true }));
    }
    if (bad === "duplicate") {
      fs.writeFileSync(f.configFile, '{"version":1,"version":1}');
    }
    if (bad === "source") {
      f.options.engineModuleUrls = [pathToFileURL(path.join(f.engineRoot, "gateway.ts")).href];
    }
    if (bad === "outside") {
      f.options.engineModuleUrls = [pathToFileURL(path.join(f.root, "outside.js")).href];
    }
    if (bad === "bad-pin") {
      fs.writeFileSync(
        f.configFile,
        JSON.stringify({
          ...f.config,
          expected: { ...f.expected, engineBuildHash: "0".repeat(64) },
        }),
      );
    }
    if (bad === "installation-claim") {
      fs.writeFileSync(
        f.installationFile,
        JSON.stringify({
          version: 1,
          installationId: f.expected.installationId,
          rolePolicyHash: f.expected.rolePolicyHash,
        }),
      );
    }
    assert.throws(() => readLegalEvidenceStartup(f.options));
  });
}
test("configured startup refuses clearing or changing the opt-in environment after publication", ({
  onTestFinished,
}) => {
  const f = fixture(onTestFinished);
  let currentFile: string | undefined = f.configFile;
  const read = readLegalEvidenceStartup({ ...f.options, readConfigFile: () => currentFile })!;
  assert.deepEqual(read(), f.expected);
  currentFile = undefined;
  assert.throws(read, /drift/);
  currentFile = f.configFile + ".other";
  assert.throws(read, /drift/);
});
