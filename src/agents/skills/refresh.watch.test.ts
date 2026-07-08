import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { ensureSkillsWatcher, getSkillsSnapshotVersion } from "./refresh.js";

// Passing watch: false closes and removes a workspace watcher (used for cleanup).
const disableWatchConfig = { skills: { load: { watch: false } } } as OpenClawConfig;

describe("ensureSkillsWatcher (real filesystem)", () => {
  let workspaceDir = "";

  afterEach(() => {
    if (workspaceDir) {
      ensureSkillsWatcher({ workspaceDir, config: disableWatchConfig });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
    }
  });

  it("bumps the snapshot version when a SKILL.md in <workspace>/skills/<name>/ changes", async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skills-watch-"));
    const skillDir = path.join(workspaceDir, "skills", "demo");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillFile, "---\nname: demo\n---\ninitial\n");

    ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { watchDebounceMs: 50 } } } as OpenClawConfig,
    });
    const before = getSkillsSnapshotVersion(workspaceDir);

    // Re-write the file periodically until the watcher reports the change;
    // chokidar arms asynchronously, so a single write can race watcher startup.
    const deadline = Date.now() + 10_000;
    let revision = 0;
    while (Date.now() < deadline && getSkillsSnapshotVersion(workspaceDir) <= before) {
      revision += 1;
      fs.writeFileSync(skillFile, `---\nname: demo\n---\nupdated ${revision}\n`);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(before);
  }, 20_000);
});
