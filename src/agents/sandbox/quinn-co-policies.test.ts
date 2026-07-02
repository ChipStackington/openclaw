import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// Validates the live Quinn-Co seed files (Phase 1 Task 14). These live outside
// the repo in the Quinn-Co state dir; skip everywhere that dir doesn't exist
// so CI and other machines aren't coupled to Jared's box.
const STATE = "C:/Users/jared/.openclaw-quinn-co";
const describeLive = existsSync(STATE) ? describe : describe.skip;

describeLive("quinn-co seeded sandbox policies", () => {
  it("credential-bags.json is version 1 with per-agent bags", () => {
    const j = JSON.parse(readFileSync(`${STATE}/credential-bags.json`, "utf8"));
    expect(j.version).toBe(1);
    expect(Array.isArray(j.bags)).toBe(true);
    expect(
      j.bags.every(
        (b: { agentId?: unknown; vars?: unknown }) =>
          typeof b.agentId === "string" && typeof b.vars === "object" && b.vars !== null,
      ),
    ).toBe(true);
  });

  it("network-policies.json uses valid modes", () => {
    const j = JSON.parse(readFileSync(`${STATE}/network-policies.json`, "utf8"));
    expect(j.version).toBe(1);
    expect(Array.isArray(j.policies)).toBe(true);
    expect(
      j.policies.every((p: { mode?: unknown }) =>
        ["none", "open", "allowlist"].includes(p.mode as string),
      ),
    ).toBe(true);
  });

  it("openclaw.json has sandbox enabled for non-main agents", () => {
    const j = JSON.parse(readFileSync(`${STATE}/openclaw.json`, "utf8"));
    expect(j.tools?.sandbox?.mode).toBe("non-main");
  });
});
