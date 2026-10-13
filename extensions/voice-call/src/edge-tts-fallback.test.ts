import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));
vi.mock("node-edge-tts", () => ({
  EdgeTTS: class {
    ttsPromise = synthesize;
  },
}));

import { edgeTtsFallback } from "./edge-tts-fallback.js";

describe("edgeTtsFallback temporary audio", () => {
  afterEach(() => synthesize.mockReset());

  it("allocates a private directory and removes it after reading the MP3", async () => {
    let output = "";
    synthesize.mockImplementation(async (_text: string, file: string) => {
      output = file;
      expect(path.basename(path.dirname(file))).toMatch(/^edge-tts-/);
      expect(path.basename(file)).toBe("speech.mp3");
      expect(fs.readdirSync(path.dirname(file))).toEqual([]);
      fs.writeFileSync(file, "test-audio");
    });
    await expect(edgeTtsFallback("hello")).resolves.toEqual({
      audio: Buffer.from("test-audio"),
      format: "mp3",
    });
    expect(fs.existsSync(path.dirname(output))).toBe(false);
  });

  it("removes partial audio and its directory when synthesis fails", async () => {
    let output = "";
    synthesize.mockImplementation(async (_text: string, file: string) => {
      output = file;
      fs.writeFileSync(file, "partial");
      throw new Error("synthesis failed");
    });
    await expect(edgeTtsFallback("hello")).rejects.toThrow("synthesis failed");
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.existsSync(path.dirname(output))).toBe(false);
  });

  it("isolates simultaneous calls even when time and weak randomness collide", async () => {
    const outputs: string[] = [];
    const releases: Array<() => void> = [];
    const now = vi.spyOn(Date, "now").mockReturnValue(1);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      synthesize.mockImplementation(async (text: string, file: string) => {
        outputs.push(file);
        fs.writeFileSync(file, text);
        await new Promise<void>((resolve) => releases.push(resolve));
      });
      const pending = Promise.allSettled([edgeTtsFallback("one"), edgeTtsFallback("two")]);
      await vi.waitFor(() => expect(outputs).toHaveLength(2));
      releases.forEach((release) => release());
      const results = await pending;
      expect(new Set(outputs.map((file) => path.dirname(file))).size).toBe(2);
      expect(results).toEqual([
        { status: "fulfilled", value: { audio: Buffer.from("one"), format: "mp3" } },
        { status: "fulfilled", value: { audio: Buffer.from("two"), format: "mp3" } },
      ]);
      expect(outputs.every((file) => !fs.existsSync(path.dirname(file)))).toBe(true);
    } finally {
      releases.forEach((release) => release());
      now.mockRestore();
      random.mockRestore();
    }
  });
});
