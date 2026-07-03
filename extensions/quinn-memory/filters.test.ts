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
  it("truncates head-preserving at the cap", () => {
    const messages = [{ role: "user", content: "a".repeat(500) }, { role: "user", content: "b".repeat(500) }];
    const pairs = toRoleTextPairs(messages, 600);
    const total = pairs.reduce((n, p) => n + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(600);
    expect(pairs[0]!.text.startsWith("aaa")).toBe(true);
  });
});
