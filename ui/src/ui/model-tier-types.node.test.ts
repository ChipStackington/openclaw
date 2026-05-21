import { describe, expect, it } from "vitest";
import { MODEL_TIER_LABELS, MODEL_TIER_MODELS } from "./model-tier-types.js";

describe("model tier UI metadata", () => {
  it("uses Executive as the public label for the internal baller tier", () => {
    expect(MODEL_TIER_LABELS.baller).toBe("Executive");
  });

  it("describes Einstein Mode as OpenAI Codex GPT-5.5", () => {
    expect(MODEL_TIER_MODELS.einstein).toBe("OpenAI Codex GPT-5.5");
  });
});
