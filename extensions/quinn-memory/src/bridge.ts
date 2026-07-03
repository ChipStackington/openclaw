/**
 * HTTP bridge to the Quinn-Co dashboard memory endpoints. Fail-open
 * everywhere: memory being down must never block or slow an agent run
 * beyond the timeout. (Same posture as quinn-security/src/bridge.ts.)
 */

export type InjectInput = { orgId: string; agentId: string; prompt: string };
export type ExtractInput = {
  orgId: string;
  agentId: string;
  sessionId: string;
  messages: Array<{ role: string; text: string }>;
};

const INJECT_TIMEOUT_MS = 1_500;
const EXTRACT_TIMEOUT_MS = 5_000;

export async function fetchMemoryBlock(
  baseUrl: string,
  input: InjectInput,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/memory/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { block?: unknown };
    return typeof data.block === "string" && data.block.trim() ? data.block : null;
  } catch {
    return null;
  }
}

export async function postExtract(
  baseUrl: string,
  input: ExtractInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(`${baseUrl}/api/memory/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });
  } catch {
    // fire-and-forget: extraction loss is acceptable, agent impact is not
  }
}
