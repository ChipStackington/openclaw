import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bridgeEvaluate } from "./src/bridge.js";
import register from "./index.js";

describe("bridgeEvaluate", () => {
  it("POSTs to /api/security/evaluate and returns the decision", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ allowed: false, blockReason: "exfil" }), { status: 200 })) as unknown as typeof fetch;
    const r = await bridgeEvaluate("http://127.0.0.1:4242", { agentId: "jack", action: "send_email", input: "x" }, fetchImpl);
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBe("exfil");
  });

  it("fails OPEN on bridge unreachable (does not brick the gateway)", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await bridgeEvaluate("http://127.0.0.1:4242", { agentId: "jack", action: "chat", input: "hi" }, fetchImpl);
    expect(r.allowed).toBe(true);
  });

  it("fails OPEN on a 200 with a non-boolean `allowed` (drifted API must not block everything)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, decision: {} }), { status: 200 })) as unknown as typeof fetch;
    const r = await bridgeEvaluate("http://127.0.0.1:4242", { agentId: "jack", action: "tool:read_file", input: "{}" }, fetchImpl);
    expect(r.allowed).toBe(true);
  });

  it("drops a non-string blockReason", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ allowed: false, blockReason: { code: 7 } }), { status: 200 })) as unknown as typeof fetch;
    const r = await bridgeEvaluate("http://127.0.0.1:4242", { agentId: "jack", action: "send_email", input: "x" }, fetchImpl);
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toBeUndefined();
  });
});

// register()-level tests pin the actual product surface: the hook handlers and
// their event/ctx → result mapping (not just bridgeEvaluate in isolation).
describe("register() hooks", () => {
  function makeApi() {
    const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
    const api: any = {
      on: (name: string, fn: (event: any, ctx: any) => Promise<any>) => { handlers[name] = fn; },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    register(api);
    return { handlers, api };
  }

  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  function stubFetch(body: unknown) {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  }

  it("before_tool_call blocks with the bridge reason and uses a tool: action prefix", async () => {
    const { handlers } = makeApi();
    let captured: any;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ allowed: false, blockReason: "exfil" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await handlers.before_tool_call({ toolName: "read_file", params: { path: "/x" } }, { agentId: "jack" });
    expect(r).toEqual({ block: true, blockReason: "exfil" });
    expect(captured.action).toBe("tool:read_file");
    expect(captured.agentId).toBe("jack");
  });

  it("before_tool_call allows (returns undefined) when the bridge allows", async () => {
    const { handlers } = makeApi();
    stubFetch({ allowed: true });
    const r = await handlers.before_tool_call({ toolName: "read_file", params: {} }, { agentId: "jack" });
    expect(r).toBeUndefined();
  });

  it("message_sending cancels + logs on block, and evaluates against the channel/account (no agentId on ctx)", async () => {
    const { handlers, api } = makeApi();
    let captured: any;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ allowed: false, blockReason: "pii" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await handlers.message_sending({ content: "hi", to: "+15551112222" }, { channelId: "sms", accountId: "acct-1" });
    expect(r).toEqual({ cancel: true });
    expect(captured.agentId).toBe("acct-1");
    expect(captured.action).toBe("message_sending");
    expect(api.logger.warn).toHaveBeenCalledOnce();
  });
});
