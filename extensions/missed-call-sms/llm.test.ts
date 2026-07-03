import { describe, expect, it } from "vitest";
import { extractPayloadText, parseModelRef } from "./src/llm.js";

describe("parseModelRef", () => {
  it("splits provider/model on the first slash", () => {
    expect(parseModelRef("openai-codex/gpt-5.4", { provider: "p", model: "m" })).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
    });
  });
  it("falls back to default provider when no slash", () => {
    expect(parseModelRef("gpt-5.4", { provider: "openai-codex", model: "m" })).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
    });
  });
});

describe("extractPayloadText", () => {
  it("joins non-error text payloads and trims", () => {
    expect(
      extractPayloadText([
        { text: "[SEND] Hi there " },
        { text: "ignored", isError: true },
        { text: undefined },
      ]),
    ).toBe("[SEND] Hi there");
  });
  it("returns empty string for missing payloads", () => {
    expect(extractPayloadText(undefined)).toBe("");
  });
});
