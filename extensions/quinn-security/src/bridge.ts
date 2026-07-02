export type BridgeInput = {
  agentId: string;
  action: string;
  input: string;
  target?: string;
  skillId?: string;
};
export type BridgeDecision = { allowed: boolean; blockReason?: string };

export async function bridgeEvaluate(
  baseUrl: string,
  input: BridgeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BridgeDecision> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/security/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { allowed: true }; // fail-open on bridge error; logged upstream
    const data = (await res.json()) as { allowed?: unknown; blockReason?: unknown };
    // Fail OPEN on a shape we don't recognize: a drifted API (missing/non-boolean
    // `allowed`) must not silently BLOCK every tool call in the gateway.
    if (typeof data.allowed !== "boolean") return { allowed: true };
    return {
      allowed: data.allowed,
      blockReason: typeof data.blockReason === "string" ? data.blockReason : undefined,
    };
  } catch {
    return { allowed: true }; // bridge down must not brick the gateway
  }
}
