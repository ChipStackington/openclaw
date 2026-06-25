// Forward producer for the Judge: POSTs a completed agent task to the
// Quinn-Co workspace bus. Fire-and-forget — never throws, never blocks the
// agent run. The sink URL is an operator-configured trusted (usually
// loopback) endpoint, so we deliberately use plain fetch + a bounded
// timeout rather than the SSRF guard (which rejects loopback).

import type { JudgeSinkConfig } from "./judge-sink-config.js";

export interface OutcomeEmit {
  task: string;
  output: string;
  runId: string;
  agentId: string;
}

const EMIT_TIMEOUT_MS = 5000;

export async function emitOutcomeToJudgeSink(
  emit: OutcomeEmit,
  sink: JudgeSinkConfig,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = sink.url.replace(/\/+$/, "");
  try {
    const res = await fetchImpl(`${base}/api/agent-events/emit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sink.token}`,
      },
      body: JSON.stringify({
        type: "agent.task.completed",
        source_agent_id: emit.agentId,
        source_agent_name: emit.agentId,
        department: sink.department ?? "unknown",
        payload: { task: emit.task, output: emit.output },
        trace_id: emit.runId,
      }),
      signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[judge-sink] emit non-2xx (${res.status}) for run ${emit.runId}`);
    }
  } catch (err) {
    console.warn(`[judge-sink] emit failed for run ${emit.runId}: ${String(err)}`);
  }
}

export function extractOutputText(
  result: { payloads?: Array<{ text?: string }> } | null | undefined,
): string {
  const texts = (result?.payloads ?? [])
    .map((p) => p.text)
    .filter((t): t is string => Boolean(t && t.trim()));
  return texts.join("\n").trim();
}

export interface MaybeEmitArgs {
  sink: JudgeSinkConfig | undefined;
  spawnedBy: string | undefined;
  suppressOutcomeEmit: boolean | undefined;
  agentId: string | undefined;
  task: string;
  result: { payloads?: Array<{ text?: string }> } | null | undefined;
  runId: string;
}

// Applies every skip gate (no sink / subagent / suppressed re-dispatch / no agentId / empty output)
// then fires the emit fire-and-forget. Returns whether it emitted so the gateway hook + tests can
// assert without awaiting the POST.
export function maybeEmitOutcome(
  args: MaybeEmitArgs,
  deps: { emitImpl?: (e: OutcomeEmit, s: JudgeSinkConfig) => void } = {},
): boolean {
  if (!args.sink) return false;
  if (args.spawnedBy) return false; // top-level only
  if (args.suppressOutcomeEmit) return false; // judge re-dispatch
  if (!args.agentId) return false;
  const output = extractOutputText(args.result);
  if (!output) return false; // nothing to judge
  const emit: OutcomeEmit = { task: args.task, output, runId: args.runId, agentId: args.agentId };
  const emitImpl = deps.emitImpl ?? ((e, s) => void emitOutcomeToJudgeSink(e, s));
  emitImpl(emit, args.sink);
  return true;
}
