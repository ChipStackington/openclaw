import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { loadPluginManifest } from "../../src/plugins/manifest.js";

const pluginRootDir = path.dirname(fileURLToPath(import.meta.url));

describe("quinn-memory plugin manifest", () => {
  it("loads and validates through the real plugin loader", () => {
    const result = loadPluginManifest(pluginRootDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("quinn-memory");
      expect(result.manifest.configSchema).toEqual({
        type: "object",
        additionalProperties: false,
        properties: {},
      });
    }
  });
});
