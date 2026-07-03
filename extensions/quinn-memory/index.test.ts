import { afterEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";

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

describe("register() hooks", () => {
  it("registers before_agent_start and agent_end", () => {
    const { handlers } = makeApi();
    expect(typeof handlers.before_agent_start).toBe("function");
    expect(typeof handlers.agent_end).toBe("function");
  });

  it("before_agent_start returns prependContext from the bridge block", async () => {
    const { handlers } = makeApi();
    let captured: any;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ block: "<agent-memory>x</agent-memory>", memoriesUsed: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await handlers.before_agent_start(
      { prompt: "When does Acme want delivery?" },
      { agentId: "jack", sessionKey: "agent:jack:main", trigger: "user" },
    );
    expect(r).toEqual({ prependContext: "<agent-memory>x</agent-memory>" });
    expect(captured.agentId).toBe("jack");
    expect(captured.prompt).toContain("Acme");
  });

  it("before_agent_start returns undefined on bridge failure (fail-open)", async () => {
    const { handlers } = makeApi();
    globalThis.fetch = vi.fn(async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const r = await handlers.before_agent_start({ prompt: "x" }, { agentId: "jack", trigger: "user" });
    expect(r).toBeUndefined();
  });

  it("before_agent_start skips sms/subagent/heartbeat runs without fetching", async () => {
    const { handlers } = makeApi();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    expect(await handlers.before_agent_start({ prompt: "x" }, { sessionKey: "sms:1555" })).toBeUndefined();
    expect(await handlers.before_agent_start({ prompt: "x" }, { sessionKey: "agent:a:subagent:b" })).toBeUndefined();
    expect(await handlers.before_agent_start({ prompt: "x" }, { trigger: "heartbeat" })).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("agent_end posts role/text pairs for successful eligible turns", async () => {
    const { handlers } = makeApi();
    let captured: any;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ queued: true }), { status: 202 });
    }) as unknown as typeof fetch;
    await handlers.agent_end(
      { messages: [{ role: "user", content: "Remember Acme prefers Tuesdays" }], success: true },
      { agentId: "jack", sessionId: "s1", sessionKey: "agent:jack:main" },
    );
    // fire-and-forget: give the microtask a beat
    await new Promise((r) => setTimeout(r, 20));
    expect(captured.url).toContain("/api/memory/extract");
    expect(captured.body.agentId).toBe("jack");
    expect(captured.body.messages[0]).toEqual({ role: "user", text: "Remember Acme prefers Tuesdays" });
  });

  it("agent_end skips failed turns and ineligible runs", async () => {
    const { handlers } = makeApi();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await handlers.agent_end({ messages: [{ role: "user", content: "x" }], success: false }, { agentId: "jack" });
    await handlers.agent_end({ messages: [{ role: "user", content: "x" }], success: true }, { sessionKey: "sms:1555" });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
