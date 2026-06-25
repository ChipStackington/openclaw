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
