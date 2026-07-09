import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const embedCss = readFileSync(join(process.cwd(), "ui", "src", "styles", "embed.css"), "utf-8");

describe("mission control embed compositor policy", () => {
  it("does not promote chat layout surfaces to compositor layers", () => {
    expect(
      embedCss,
      "MC embed chat surfaces should not force GPU layers; rect-stable promoted layers can visually jitter during orb/canvas repaints",
    ).not.toMatch(/translateZ\(0\)|backface-visibility:\s*hidden|will-change:\s*transform/);
    expect(
      embedCss,
      "the composer should still suppress layout-affecting transitions",
    ).toMatch(/\.shell--mc-embed \.chat-compose .*\{[\s\S]*?transition:\s*none !important;[\s\S]*?\}/);
    expect(
      embedCss,
      "the embedded chat card should not keep the base transform transition",
    ).toMatch(/\.shell--mc-embed \.card\.chat,[\s\S]*?\.shell--mc-embed \.chat \{[\s\S]*?transition:\s*none !important;[\s\S]*?\}/);
    expect(
      embedCss,
      "the composer action row should not keep inherited transition-all behavior",
    ).toMatch(/\.shell--mc-embed \.chat-compose__actions \{[\s\S]*?transition:\s*none !important;[\s\S]*?\}/);
  });
});
