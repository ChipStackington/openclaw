import { describe, expect, it } from "vitest";
import { isEligibleRun, shouldInject, toRoleTextPairs } from "./src/filters.js";

describe("isEligibleRun (shared skip rules)", () => {
  it("skips subagent, cron, sms, voice runs", () => {
    expect(isEligibleRun({ sessionKey: "agent:main:subagent:abc" })).toBe(false);
    expect(isEligibleRun({ sessionKey: "subagent:abc" })).toBe(false);
    expect(isEligibleRun({ sessionKey: "agent:main:cron:job1" })).toBe(false);
    expect(isEligibleRun({ sessionKey: "cron:job1" })).toBe(false);
    expect(isEligibleRun({ sessionKey: "sms:15551234567" })).toBe(false);
    expect(isEligibleRun({ messageProvider: "sms", sessionKey: "agent:main:x" })).toBe(false);
    expect(isEligibleRun({ sessionKey: "voice:15551234567" })).toBe(false);
    expect(isEligibleRun({ messageProvider: "voice" })).toBe(false);
  });
  it("passes ordinary main-session runs", () => {
    expect(isEligibleRun({ sessionKey: "agent:main:main", messageProvider: "webchat" })).toBe(true);
    expect(isEligibleRun({})).toBe(true);
  });
});

describe("shouldInject", () => {
  it("skips non-user triggers", () => {
    expect(shouldInject({ trigger: "heartbeat", sessionKey: "agent:main:main" })).toBe(false);
    expect(shouldInject({ trigger: "cron" })).toBe(false);
    expect(shouldInject({ trigger: "memory" })).toBe(false);
  });
  it("injects for user/undefined triggers on eligible runs", () => {
    expect(shouldInject({ trigger: "user", sessionKey: "agent:main:main" })).toBe(true);
    expect(shouldInject({ sessionKey: "agent:main:main" })).toBe(true);
  });
});

describe("toRoleTextPairs", () => {
  it("maps string and block content, keeps user/assistant only, caps chars", () => {
    const messages = [
      { role: "user", content: "plain string" },
      { role: "assistant", content: [{ type: "text", text: "block text" }, { type: "thinking", thinking: "x" }] },
      { role: "toolResult", content: [{ type: "text", text: "tool noise" }] },
    ];
    const pairs = toRoleTextPairs(messages, 1000);
    expect(pairs).toEqual([
      { role: "user", text: "plain string" },
      { role: "assistant", text: "block text" },
    ]);
  });
  it("truncates tail-preserving at the cap: newest message survives whole, oldest is trimmed from its front", () => {
    const messages = [{ role: "user", content: "a".repeat(500) }, { role: "user", content: "b".repeat(500) }];
    const pairs = toRoleTextPairs(messages, 600);
    const total = pairs.reduce((n, p) => n + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(600);
    // chronological order preserved: oldest (trimmed "a"s) first, newest ("b"s, whole) last.
    expect(pairs[pairs.length - 1]!.text).toBe("b".repeat(500));
    expect(pairs[0]!.text.endsWith("aaa")).toBe(true);
    expect(pairs[0]!.text.length).toBe(100);
  });

  it("drops the oldest message entirely once the newest alone fills the budget", () => {
    // Both messages are exactly 500 chars so the newest fits whole and
    // consumes the entire budget, leaving nothing for the oldest.
    const messages = [
      { role: "user", content: "OLDEST-".padEnd(500, "x") },
      { role: "assistant", content: "NEWEST-".padEnd(500, "y") },
    ];
    const pairs = toRoleTextPairs(messages, 500);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.text).toContain("NEWEST");
    expect(pairs.some((p) => p.text.includes("OLDEST"))).toBe(false);
  });

  it("preserves chronological order across many messages once truncated to the tail", () => {
    // Each message is exactly 200 chars; a 400-char budget fits exactly the
    // newest two whole, and the loop stops before touching older ones.
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg${i}-` + "z".repeat(195),
    }));
    const pairs = toRoleTextPairs(messages, 400);
    expect(pairs.map((p) => p.text.split("-")[0])).toEqual(["msg3", "msg4"]);
  });
});
