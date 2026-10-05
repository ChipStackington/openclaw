import { describe, expect, it, vi } from "vitest";
import { legalEvidenceHandlers } from "./legal-evidence.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const context = () => ({}) as GatewayRequestContext;
const client = (overrides: Record<string, unknown> = {}): GatewayClient =>
  ({
    authenticatedDeviceId: "verified-device-1",
    connect: {
      role: "operator",
      scopes: ["operator.read"],
      client: { id: "mission-control-cli", mode: "cli" },
    },
    ...overrides,
  }) as unknown as GatewayClient;

describe("legal evidence gateway RPCs", () => {
  it("fails capabilities closed until measured runtime pins are available", async () => {
    const respond = vi.fn();
    await legalEvidenceHandlers["agent.evidence.capabilities"]({
      params: {},
      client: client(),
      isWebchatConnect: () => false,
      respond,
      req: { type: "req", id: "capability-test", method: "agent.evidence.capabilities" },
      context: context(),
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "legal-evidence-unavailable" }),
    );
  });

  it.each([
    ["missing proof", client({ authenticatedDeviceId: undefined }), () => false],
    [
      "missing read scope",
      client({ connect: { ...client().connect, scopes: ["operator.write"] } }),
      () => false,
    ],
    [
      "webchat",
      client({ connect: { ...client().connect, client: { id: "webchat", mode: "webchat" } } }),
      () => true,
    ],
  ])("rejects evidence reads from %s", async (_label, caller, isWebchatConnect) => {
    const respond = vi.fn();
    await legalEvidenceHandlers["agent.evidence.get"]({
      params: { operationId: "00000000-0000-4000-8000-000000000001" },
      client: caller as never,
      isWebchatConnect: isWebchatConnect as never,
      respond,
      req: { type: "req", id: "get-test", method: "agent.evidence.get" },
      context: context(),
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
  });

  it("rejects unknown RPC keys before reading durable state", async () => {
    const respond = vi.fn();
    await legalEvidenceHandlers["agent.evidence.get"]({
      params: { operationId: "00000000-0000-4000-8000-000000000001", path: "../outside" },
      client: client(),
      isWebchatConnect: () => false,
      respond,
      req: { type: "req", id: "get-test", method: "agent.evidence.get" },
      context: context(),
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
  });
});
