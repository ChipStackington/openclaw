import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { gateway: { mode: "local", port: 19100 } },
  call: vi.fn(),
  env: vi.fn(),
  normalize: vi.fn(),
  guard: vi.fn(),
}));
vi.mock("./config/config.js", () => ({ readBestEffortConfig: async () => mocks.config }));
vi.mock("./gateway/call.js", () => ({ callGateway: mocks.call }));
vi.mock("./infra/dotenv.js", () => ({ loadDotEnv: mocks.env }));
vi.mock("./infra/env.js", () => ({ normalizeEnv: mocks.normalize }));
vi.mock("./infra/runtime-guard.js", () => ({ assertSupportedRuntime: mocks.guard }));

beforeEach(() => vi.clearAllMocks());

it("uses the ordinary CLI identity, config and authentication client without waiting for agent completion", async () => {
  const { callGatewayRpc } = await import("./gateway-rpc.js");
  const params = { message: "private 😀", idempotencyKey: "original", deliver: false };
  mocks.call.mockResolvedValue({ status: "accepted", runId: "original" });
  await expect(callGatewayRpc("agent", params, 8000)).resolves.toEqual({
    status: "accepted",
    runId: "original",
  });
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith({
    config: mocks.config,
    method: "agent",
    params,
    timeoutMs: 8000,
    expectFinal: false,
    clientName: "cli",
    mode: "cli",
  });
  expect(mocks.env).toHaveBeenCalledWith({ quiet: true });
  expect(mocks.normalize).toHaveBeenCalledOnce();
  expect(mocks.guard).toHaveBeenCalledOnce();
});

it("propagates uncertain failure without retrying", async () => {
  const { callGatewayRpc } = await import("./gateway-rpc.js");
  mocks.call.mockRejectedValue(new Error("connection lost"));
  await expect(callGatewayRpc("agent", { idempotencyKey: "original" }, 8000)).rejects.toThrow(
    "connection lost",
  );
  expect(mocks.call).toHaveBeenCalledOnce();
});
