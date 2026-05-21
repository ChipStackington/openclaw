import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { selectGatewayLiveWantedModels } from "./gateway-models.profiles.live.test.js";

describe("gateway live model candidate selection", () => {
  it("synthesizes explicit forward-compatible models missing from the registry", () => {
    const codexTemplate = {
      provider: "openai-codex",
      id: "gpt-5.4",
      name: "gpt-5.4",
      api: "openai-codex-responses",
      input: ["text", "image"],
      reasoning: true,
    } as Model<Api>;
    const modelRegistry = {
      getAll: () => [codexTemplate],
      find: (provider: string, id: string) =>
        provider === "openai-codex" && id === "gpt-5.4" ? codexTemplate : null,
    } as unknown as ModelRegistry;

    const selected = selectGatewayLiveWantedModels({
      all: modelRegistry.getAll(),
      modelRegistry,
      rawModels: "openai-codex/gpt-5.5",
    });

    expect(selected.useExplicit).toBe(true);
    expect(selected.models).toHaveLength(1);
    expect(selected.models[0]).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.5",
      api: "openai-codex-responses",
    });
  });
});
