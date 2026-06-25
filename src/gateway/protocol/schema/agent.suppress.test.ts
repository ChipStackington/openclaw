import { describe, expect, it } from "vitest";
import { validateAgentParams } from "../index.js";

describe("agent params schema — suppressOutcomeEmit", () => {
  it("accepts suppressOutcomeEmit: true", () => {
    const ok = validateAgentParams({
      message: "hi",
      idempotencyKey: "k1",
      suppressOutcomeEmit: true,
    });
    expect(ok).toBe(true);
  });
  it("still accepts params without the field", () => {
    expect(validateAgentParams({ message: "hi", idempotencyKey: "k1" })).toBe(true);
  });
});
