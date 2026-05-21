export type ModelTierMode = "economy" | "baller" | "einstein";

export const MODEL_TIER_LABELS: Record<ModelTierMode, string> = {
  economy: "Economy",
  baller: "Executive",
  einstein: "Einstein",
};

export const MODEL_TIER_COST: Record<ModelTierMode, string> = {
  economy: "$",
  baller: "$$",
  einstein: "$$$$",
};

export const MODEL_TIER_COLORS: Record<ModelTierMode, string> = {
  economy: "#4CAF50",
  baller: "#0A9EFC",
  einstein: "#9C27B0",
};

export const MODEL_TIER_MODELS: Record<ModelTierMode, string> = {
  economy: "GPT-5.4 Mini",
  baller: "GPT-5.4",
  einstein: "OpenAI Codex GPT-5.5",
};
