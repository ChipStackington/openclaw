import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearAllBootstrapSnapshots, getOrLoadBootstrapFiles } from "./bootstrap-cache.js";

// Real-fs regression test for the stale-bootstrap-snapshot bug: a session key's
// cached IDENTITY.md must not outlive an on-disk edit (same disease the skills
// snapshot had — sessions kept serving boot-time content until restart/rollover).
describe("getOrLoadBootstrapFiles freshness (real filesystem)", () => {
  let workspaceDir = "";

  afterEach(() => {
    clearAllBootstrapSnapshots();
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
    }
  });

  it("returns updated content after a bootstrap file changes on disk for the same session key", async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bootstrap-cache-"));
    const identityPath = path.join(workspaceDir, "IDENTITY.md");
    fs.writeFileSync(identityPath, "# Identity v1\n");

    const first = await getOrLoadBootstrapFiles({
      workspaceDir,
      sessionKey: "agent:main:main",
    });
    expect(first.find((f) => f.name === "IDENTITY.md")?.content).toContain("v1");

    fs.writeFileSync(identityPath, "# Identity v2 — now with two more chains\n");

    const second = await getOrLoadBootstrapFiles({
      workspaceDir,
      sessionKey: "agent:main:main",
    });
    expect(second.find((f) => f.name === "IDENTITY.md")?.content).toContain("v2");
  });

  it("picks up a bootstrap file created after the first load", async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bootstrap-cache-"));
    fs.writeFileSync(path.join(workspaceDir, "IDENTITY.md"), "# Identity\n");

    const first = await getOrLoadBootstrapFiles({
      workspaceDir,
      sessionKey: "agent:main:main",
    });
    expect(first.find((f) => f.name === "SOUL.md")?.missing).toBe(true);

    fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "# Soul\n");

    const second = await getOrLoadBootstrapFiles({
      workspaceDir,
      sessionKey: "agent:main:main",
    });
    expect(second.find((f) => f.name === "SOUL.md")?.missing).toBe(false);
  });
});
