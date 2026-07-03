import { describe, expect, it } from "vitest";
import { MissedCallSmsConfigSchema, validateProviderConfig } from "./src/config.js";

describe("missed-call-sms config", () => {
  it("defaults llm.modelRef to openai-codex/gpt-5.4", () => {
    const cfg = MissedCallSmsConfigSchema.parse({});
    expect(cfg.llm.modelRef).toBe("openai-codex/gpt-5.4");
  });

  it("tolerates a legacy anthropic block without crashing", () => {
    const cfg = MissedCallSmsConfigSchema.parse({
      anthropic: { model: "claude-haiku-4-5-20251001" },
    });
    expect(cfg.llm.modelRef).toBe("openai-codex/gpt-5.4");
  });

  it("does not require anthropic.apiKey to be valid", () => {
    const cfg = MissedCallSmsConfigSchema.parse({
      telnyx: {
        apiKey: "KEY123",
        connectionId: "conn1",
        messagingProfileId: "mp1",
        fromNumber: "+15550001111",
      },
      deepgram: { apiKey: "dg1", model: "nova-3" },
    });
    const v = validateProviderConfig(cfg);
    expect(v.errors).not.toContain("anthropic.apiKey is required");
    expect(v.valid).toBe(true);
  });
});
