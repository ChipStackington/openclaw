import { describe, expect, it, vi } from "vitest";
import { emitOutcomeToJudgeSink } from "./judge-sink.js";

const sink = { url: "http://127.0.0.1:4242/", token: "tok", department: "sales" };
const emit = { task: "do X", output: "did X", runId: "run-1", agentId: "jack" };

describe("emitOutcomeToJudgeSink", () => {
  it("POSTs the correct url, headers, and body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    await emitOutcomeToJudgeSink(emit, sink, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4242/api/agent-events/emit"); // trailing slash collapsed
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      type: "agent.task.completed",
      source_agent_id: "jack",
      department: "sales",
      payload: { task: "do X", output: "did X" },
      trace_id: "run-1",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults department to 'unknown' when sink has none", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    await emitOutcomeToJudgeSink(emit, { url: "u", token: "t" }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.department).toBe("unknown");
  });

  it("swallows a rejected fetch (never throws)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      emitOutcomeToJudgeSink(emit, sink, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });

  it("swallows a non-2xx response (never throws)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      emitOutcomeToJudgeSink(emit, sink, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });
});
