import { describe, it, expect, vi } from "vitest";
import { bridgeEvaluate } from "./src/bridge.js";

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
});
