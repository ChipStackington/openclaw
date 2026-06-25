import { describe, expect, it, vi } from "vitest";
import { emitOutcomeToJudgeSink, extractOutputText, maybeEmitOutcome } from "./judge-sink.js";

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

describe("extractOutputText", () => {
  it("joins non-empty payload texts", () => {
    expect(extractOutputText({ payloads: [{ text: "a" }, { text: " " }, { text: "b" }] })).toBe("a\nb");
  });
  it("returns '' for missing/empty payloads", () => {
    expect(extractOutputText(undefined)).toBe("");
    expect(extractOutputText({ payloads: [] })).toBe("");
    expect(extractOutputText({ payloads: [{ text: "" }] })).toBe("");
  });
});

describe("maybeEmitOutcome", () => {
  const sink = { url: "u", token: "t" };
  const base = {
    sink,
    spawnedBy: undefined,
    suppressOutcomeEmit: undefined,
    agentId: "jack",
    task: "do X",
    result: { payloads: [{ text: "did X" }] },
    runId: "run-1",
  };
  it("emits when all conditions are met", () => {
    const emitImpl = vi.fn();
    expect(maybeEmitOutcome(base, { emitImpl })).toBe(true);
    expect(emitImpl).toHaveBeenCalledWith(
      { task: "do X", output: "did X", runId: "run-1", agentId: "jack" },
      sink,
    );
  });
  it("skips when sink is undefined", () => {
    const emitImpl = vi.fn();
    expect(maybeEmitOutcome({ ...base, sink: undefined }, { emitImpl })).toBe(false);
    expect(emitImpl).not.toHaveBeenCalled();
  });
  it("skips subagent runs (spawnedBy set)", () => {
    const emitImpl = vi.fn();
    expect(maybeEmitOutcome({ ...base, spawnedBy: "quinn" }, { emitImpl })).toBe(false);
  });
  it("skips suppressed (judge re-dispatch) runs", () => {
    const emitImpl = vi.fn();
    expect(maybeEmitOutcome({ ...base, suppressOutcomeEmit: true }, { emitImpl })).toBe(false);
  });
  it("skips when agentId missing", () => {
    const emitImpl = vi.fn();
    expect(maybeEmitOutcome({ ...base, agentId: undefined }, { emitImpl })).toBe(false);
  });
  it("skips when output text is empty", () => {
    const emitImpl = vi.fn();
    expect(maybeEmitOutcome({ ...base, result: { payloads: [] } }, { emitImpl })).toBe(false);
  });
});
