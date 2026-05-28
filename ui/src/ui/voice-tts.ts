/**
 * Ultron Voice TTS — browser-side audio playback via gateway TTS providers.
 * Calls the gateway's tts.speak method (Edge/OpenAI/ElevenLabs) and plays the returned audio.
 * Uses Web Audio API (AudioContext) to bypass CSP media-src restrictions.
 */

import type { GatewayBrowserClient } from "./gateway.ts";

const MAX_SPEECH_CHARS = 8000;
const SPEECH_ACTIVITY_FLOOR = 0.045;

let _audioContext: AudioContext | null = null;
let _currentSource: AudioBufferSourceNode | null = null;

type VoiceTelemetryState = "idle" | "speaking" | "error";

function emitVoiceTelemetry(state: VoiceTelemetryState, level = 0): void {
  try {
    window.parent?.postMessage(
      {
        type: "openclaw:voice-telemetry",
        state,
        level,
      },
      "*",
    );
  } catch {
    // Parent frame may be unavailable; voice playback should continue.
  }
}

function startAnalyserTelemetry(
  context: AudioContext,
  source: AudioBufferSourceNode,
): { stop: () => void } {
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.32;

  source.connect(analyser);
  analyser.connect(context.destination);

  const data = new Uint8Array(analyser.frequencyBinCount);
  const waveform = new Uint8Array(analyser.fftSize);
  let stopped = false;
  let frame = 0;

  const tick = () => {
    if (stopped) return;
    analyser.getByteFrequencyData(data);
    analyser.getByteTimeDomainData(waveform);
    const total = data.reduce((sum, value) => sum + value, 0);
    const frequencyLevel = total / data.length / 128;
    let squareTotal = 0;
    for (const value of waveform) {
      const centered = (value - 128) / 128;
      squareTotal += centered * centered;
    }
    const rms = Math.sqrt(squareTotal / waveform.length);
    const rawLevel = Math.min(1, Math.max(frequencyLevel, Math.max(0, rms - 0.012) * 8.5));
    const level =
      rawLevel <= SPEECH_ACTIVITY_FLOOR
        ? 0
        : Math.min(1, (rawLevel - SPEECH_ACTIVITY_FLOOR) / (1 - SPEECH_ACTIVITY_FLOOR));
    if (frame % 3 === 0) {
      emitVoiceTelemetry(level > 0 ? "speaking" : "idle", level);
    }
    frame += 1;
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);

  return {
    stop: () => {
      stopped = true;
      emitVoiceTelemetry("idle", 0);
    },
  };
}

/** Call this on user gesture (e.g. voice toggle click) to unlock AudioContext. */
export function unlockAudio(): void {
  if (!_audioContext) {
    _audioContext = new AudioContext();
  }
  if (_audioContext.state === "suspended") {
    void _audioContext.resume();
  }
  console.log("[voice] Audio unlocked, state:", _audioContext.state);
}

export function stopVoicePlayback(): void {
  if (_currentSource) {
    try {
      _currentSource.stop();
    } catch {
      // already stopped
    }
    _currentSource = null;
  }
}

export async function speakText(
  text: string,
  client: GatewayBrowserClient | null,
  agentId?: string,
): Promise<void> {
  console.log("[voice] speakText called, text length:", text.length);
  stopVoicePlayback();

  if (!client) {
    console.warn("[voice] No gateway client, skipping TTS");
    return;
  }

  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) {
    console.log("[voice] cleaned text is empty, skipping");
    return;
  }

  // Ensure AudioContext is ready
  if (!_audioContext) {
    _audioContext = new AudioContext();
  }
  if (_audioContext.state === "suspended") {
    await _audioContext.resume();
  }

  console.log("[voice] Requesting TTS from gateway...", cleaned.substring(0, 80));
  try {
    const res = await client.request<{
      audio: string;
      mime: string;
      provider: string;
    }>("tts.speak", { text: cleaned, ...(agentId ? { agentId } : {}) });

    console.log("[voice] Got audio from provider:", res.provider, "mime:", res.mime);

    // Decode base64 to ArrayBuffer
    const binary = atob(res.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    // Decode mp3/audio into AudioBuffer and play via Web Audio API
    const audioBuffer = await _audioContext.decodeAudioData(bytes.buffer);
    const source = _audioContext.createBufferSource();
    source.buffer = audioBuffer;
    const telemetry = startAnalyserTelemetry(_audioContext, source);
    source.onended = () => {
      telemetry.stop();
      _currentSource = null;
    };
    _currentSource = source;
    source.start();

    console.log("[voice] Playback started, duration:", audioBuffer.duration.toFixed(1), "s");
  } catch (err) {
    emitVoiceTelemetry("error", 0);
    console.warn("[voice] TTS failed:", err);
  }
}

function cleanTextForSpeech(text: string): string {
  let cleaned = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();

  // Truncate at sentence boundary
  if (cleaned.length > MAX_SPEECH_CHARS) {
    const truncated = cleaned.slice(0, MAX_SPEECH_CHARS);
    const lastSentence = Math.max(
      truncated.lastIndexOf(". "),
      truncated.lastIndexOf("! "),
      truncated.lastIndexOf("? "),
    );
    cleaned = lastSentence > 50 ? truncated.slice(0, lastSentence + 1) : truncated;
  }
  return cleaned;
}
