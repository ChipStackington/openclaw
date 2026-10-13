/**
 * Edge TTS fallback for telephony — zero-cost backup when Cartesia is down.
 * Generates MP3 audio via Microsoft Edge TTS (free, no API key needed).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Dynamic import to avoid hard dependency on node-edge-tts
type EdgeTTSConstructor = typeof import("node-edge-tts").EdgeTTS;
let EdgeTTSClass: EdgeTTSConstructor | null = null;

async function getEdgeTTS(): Promise<EdgeTTSConstructor> {
  if (!EdgeTTSClass) {
    const mod = await import("node-edge-tts");
    EdgeTTSClass = mod.EdgeTTS;
  }
  return EdgeTTSClass;
}

/**
 * Generate MP3 audio using Edge TTS.
 * Returns a Buffer containing MP3 audio ready for Telnyx playback_start.
 */
export async function edgeTtsFallback(
  text: string,
  voice = "en-US-AvaNeural",
  timeoutMs = 10000,
): Promise<{ audio: Buffer; format: "mp3" }> {
  const EdgeTTS = await getEdgeTTS();

  // Use MP3 format — WAV times out with Edge TTS, MP3 works fast (~600ms)
  const tts = new EdgeTTS({
    voice,
    lang: "en-US",
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
    rate: "+10%",
    timeout: timeoutMs,
  });

  // Allocate an exclusive directory so concurrent calls cannot share an audio file.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edge-tts-"));
  const tmpFile = path.join(tmpDir, "speech.mp3");

  try {
    await tts.ttsPromise(text, tmpFile);
    const mp3 = fs.readFileSync(tmpFile);
    return { audio: mp3, format: "mp3" as const };
  } finally {
    // Clean up temp file
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Preserve the synthesis result or error if cleanup fails.
    }
  }
}
