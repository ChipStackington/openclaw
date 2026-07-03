import { describe, expect, it } from "vitest";
import { loadCoreAgentDeps } from "./src/core-bridge.js";

describe("core-bridge", () => {
  it("loads the core extension API with the deps this plugin needs", async () => {
    const deps = await loadCoreAgentDeps();
    expect(typeof deps.runEmbeddedPiAgent).toBe("function");
    expect(typeof deps.resolveAgentWorkspaceDir).toBe("function");
    expect(typeof deps.resolveStorePath).toBe("function");
    expect(typeof deps.DEFAULT_PROVIDER).toBe("string");
  });
});
