import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import evidenceFixtures from "../../agents/legal-evidence/development-fixtures.json" with { type: "json" };
import { LEGAL_EVIDENCE_MODEL_POLICY_HASH } from "../../agents/legal-evidence/gateway.js";
import { evidenceHash, bytesHash } from "../../agents/legal-evidence/hash.js";
import { EngineEvidenceStore } from "../../agents/legal-evidence/store.js";
import type { CaptureRequest, RuntimeIdentity } from "../../agents/legal-evidence/types.js";
import { BARE_SESSION_RESET_PROMPT } from "../../auto-reply/reply/session-reset-prompt.js";
import { agentHandlers } from "./agent.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionStore: vi.fn(),
  agentCommand: vi.fn(),
  resolveSendPolicy: vi.fn(() => "allow" as "allow" | "deny"),
  registerAgentRunContext: vi.fn(),
  sessionsResetHandler: vi.fn(),
  maybeEmitOutcome: vi.fn(),
  loadConfigReturn: {} as Record<string, unknown>,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: mocks.updateSessionStore,
    resolveAgentIdFromSessionKey: (key: string) =>
      key.includes(":legal:") ? key.split(":")[1] : "main",
    resolveExplicitAgentSessionKey: () => undefined,
    resolveAgentMainSessionKey: ({
      cfg,
      agentId,
    }: {
      cfg?: { session?: { mainKey?: string } };
      agentId: string;
    }) => `agent:${agentId}:${cfg?.session?.mainKey ?? "main"}`,
  };
});

vi.mock("../../infra/outcomes/judge-sink.js", () => ({ maybeEmitOutcome: mocks.maybeEmitOutcome }));

vi.mock("../../commands/agent.js", () => ({
  agentCommand: mocks.agentCommand,
  agentCommandFromIngress: mocks.agentCommand,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => mocks.loadConfigReturn,
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main", "legal-facts"],
}));

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: mocks.registerAgentRunContext,
  onAgentEvent: vi.fn(),
}));

vi.mock("./sessions.js", () => ({
  sessionsHandlers: {
    "sessions.reset": (...args: unknown[]) =>
      (mocks.sessionsResetHandler as (...args: unknown[]) => unknown)(...args),
  },
}));

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: mocks.resolveSendPolicy,
}));

vi.mock("../../utils/delivery-context.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/delivery-context.js")>(
    "../../utils/delivery-context.js",
  );
  return {
    ...actual,
    normalizeSessionDeliveryFields: () => ({}),
  };
});

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    addChatRun: vi.fn(),
    logGateway: { info: vi.fn(), error: vi.fn() },
  }) as unknown as GatewayRequestContext;

type AgentHandlerArgs = Parameters<typeof agentHandlers.agent>[0];
type AgentParams = AgentHandlerArgs["params"];

type AgentIdentityGetHandlerArgs = Parameters<(typeof agentHandlers)["agent.identity.get"]>[0];
type AgentIdentityGetParams = AgentIdentityGetHandlerArgs["params"];

function mockMainSessionEntry(entry: Record<string, unknown>, cfg: Record<string, unknown> = {}) {
  mocks.loadSessionEntry.mockReturnValue({
    cfg,
    storePath: "/tmp/sessions.json",
    entry: {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      ...entry,
    },
    canonicalKey: "agent:main:main",
  });
}

function captureUpdatedMainEntry() {
  let capturedEntry: Record<string, unknown> | undefined;
  mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
    const store: Record<string, unknown> = {};
    await updater(store);
    capturedEntry = store["agent:main:main"] as Record<string, unknown>;
  });
  return () => capturedEntry;
}

function buildExistingMainStoreEntry(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "existing-session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function runMainAgentAndCaptureEntry(idempotencyKey: string) {
  const getCapturedEntry = captureUpdatedMainEntry();
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
  await runMainAgent("test", idempotencyKey);
  expect(mocks.updateSessionStore).toHaveBeenCalled();
  return getCapturedEntry();
}

function setupNewYorkTimeConfig(isoDate: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(isoDate)); // Wed Jan 28, 8:30 PM EST
  mocks.agentCommand.mockClear();
  mocks.loadConfigReturn = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
      },
    },
  };
}

function resetTimeConfig() {
  mocks.loadConfigReturn = {};
  vi.useRealTimers();
}

async function expectResetCall(expectedMessage: string) {
  await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
  expect(mocks.sessionsResetHandler).toHaveBeenCalledTimes(1);
  const call = readLastAgentCommandCall();
  expect(call?.message).toBe(expectedMessage);
  return call;
}

function primeMainAgentRun(params?: { sessionId?: string; cfg?: Record<string, unknown> }) {
  mockMainSessionEntry(
    { sessionId: params?.sessionId ?? "existing-session-id" },
    params?.cfg ?? {},
  );
  mocks.updateSessionStore.mockResolvedValue(undefined);
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
}

async function runMainAgent(message: string, idempotencyKey: string) {
  const respond = vi.fn();
  await invokeAgent(
    {
      message,
      agentId: "main",
      sessionKey: "agent:main:main",
      idempotencyKey,
    },
    { respond, reqId: idempotencyKey },
  );
  return respond;
}

function readLastAgentCommandCall():
  | {
      message?: string;
      sessionId?: string;
    }
  | undefined {
  return mocks.agentCommand.mock.calls.at(-1)?.[0] as
    | { message?: string; sessionId?: string }
    | undefined;
}

function mockSessionResetSuccess(params: {
  reason: "new" | "reset";
  key?: string;
  sessionId?: string;
}) {
  const key = params.key ?? "agent:main:main";
  const sessionId = params.sessionId ?? "reset-session-id";
  mocks.sessionsResetHandler.mockImplementation(
    async (opts: {
      params: { key: string; reason: string };
      respond: (ok: boolean, payload?: unknown) => void;
    }) => {
      expect(opts.params.key).toBe(key);
      expect(opts.params.reason).toBe(params.reason);
      opts.respond(true, {
        ok: true,
        key,
        entry: { sessionId },
      });
    },
  );
}

async function invokeAgent(
  params: AgentParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
    client?: AgentHandlerArgs["client"];
    isWebchatConnect?: AgentHandlerArgs["isWebchatConnect"];
  },
) {
  const respond = options?.respond ?? vi.fn();
  await agentHandlers.agent({
    params,
    respond: respond as never,
    context: options?.context ?? makeContext(),
    req: { type: "req", id: options?.reqId ?? "agent-test-req", method: "agent" },
    client: options?.client ?? null,
    isWebchatConnect: options?.isWebchatConnect ?? (() => false),
  });
  return respond;
}

async function invokeAgentIdentityGet(
  params: AgentIdentityGetParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
  },
) {
  const respond = options?.respond ?? vi.fn();
  await agentHandlers["agent.identity.get"]({
    params,
    respond: respond as never,
    context: options?.context ?? makeContext(),
    req: {
      type: "req",
      id: options?.reqId ?? "agent-identity-test-req",
      method: "agent.identity.get",
    },
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("gateway agent handler", () => {
  it("fails evidence ingress closed before acknowledgement without measured runtime pins", async () => {
    mocks.agentCommand.mockClear();
    const respond = await invokeAgent({
      message: "offline test assignment",
      agentId: "legal-facts",
      sessionKey: "agent:legal-facts:legal:00000000-0000-4000-8000-000000000001",
      thinking: "high",
      deliver: false,
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
      legalEvidence: {},
    } as AgentParams);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0]).toBe(false);
    expect(respond.mock.calls[0][2]).toMatchObject({ code: expect.any(String) });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("acks only after durable prepare and does not redispatch after context restart", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "quinn-b3-agent-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const prompt = "offline legal assignment with exact bound text";
    const descriptor = structuredClone(evidenceFixtures.records.capture) as CaptureRequest;
    const runtime = structuredClone(
      evidenceFixtures.records.engine.record.runtime,
    ) as RuntimeIdentity;
    descriptor.binding.operationId = "00000000-0000-4000-8000-000000000021";
    descriptor.binding.runId = "00000000-0000-4000-8000-000000000022";
    descriptor.binding.sessionKey = "agent:legal-facts:legal:00000000-0000-4000-8000-000000000021";
    descriptor.binding.submittedPromptHash = bytesHash(prompt);
    descriptor.binding.modelPolicyHash = LEGAL_EVIDENCE_MODEL_POLICY_HASH;
    descriptor.binding.engineInstallationId = runtime.installationId;
    descriptor.binding.engineRevision = runtime.engineRevision;
    descriptor.binding.engineBuildHash = runtime.engineBuildHash;
    descriptor.binding.engineAdapterVersion = runtime.adapterVersion;
    descriptor.binding.engineAdapterPatchHash = runtime.adapterPatchHash;
    descriptor.binding.engineAdapterContentHash = runtime.adapterContentHash;
    descriptor.binding.engineRolePolicyHash = runtime.rolePolicyHash;
    descriptor.binding.deadlineAt = new Date(Date.now() + 5 * 60_000).toISOString();
    descriptor.bindingHash = evidenceHash(descriptor.binding);

    const store = new EngineEvidenceStore(path.join(stateDir, "quinn-legal-evidence-v1"));
    const respond = vi.fn((ok: boolean, payload?: unknown) => {
      if (ok && (payload as { status?: string } | undefined)?.status === "accepted") {
        const durable = store.read(descriptor.binding.operationId);
        expect(durable.record.state).toBe("prepared");
      }
    });
    const request = {
      message: prompt,
      agentId: "legal-facts",
      sessionKey: descriptor.binding.sessionKey,
      thinking: "high",
      deliver: false,
      idempotencyKey: descriptor.binding.operationId,
      legalEvidence: descriptor,
    } as AgentParams;
    const ctx = {
      ...makeContext(),
      legalEvidenceReadRuntime: () => structuredClone(runtime),
    } as GatewayRequestContext;
    mocks.loadConfigReturn = {};
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: path.join(stateDir, "sessions.json"),
      entry: { sessionId: "legal-session-1", updatedAt: Date.now() },
      canonicalKey: descriptor.binding.sessionKey,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      await updater({});
      return undefined;
    });
    mocks.agentCommand.mockReset().mockImplementation(() => new Promise(() => {}));
    const authenticatedClient = {
      authenticatedDeviceId: "verified-device-1",
      connect: {
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        client: { id: "mission-control-cli", mode: "cli" },
      },
    } as never;

    try {
      await invokeAgent(request, {
        respond,
        context: ctx,
        client: authenticatedClient,
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls[0][1]).toMatchObject({ status: "accepted" });
      expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
      expect(mocks.agentCommand.mock.calls[0][0]).toMatchObject({
        message: prompt,
        legalEvidenceCapture: expect.any(Object),
      });
      expect(store.read(descriptor.binding.operationId).record.attempts).toEqual([]);

      const duplicateRespond = vi.fn();
      await invokeAgent(request, {
        respond: duplicateRespond,
        context: ctx,
        client: authenticatedClient,
        isWebchatConnect: () => false,
      });
      expect(duplicateRespond.mock.calls[0][1]).toMatchObject({ state: "prepared" });
      expect(mocks.agentCommand).toHaveBeenCalledTimes(1);

      const restartedRespond = vi.fn();
      await invokeAgent(request, {
        respond: restartedRespond,
        context: {
          ...makeContext(),
          legalEvidenceReadRuntime: () => structuredClone(runtime),
        } as GatewayRequestContext,
        client: authenticatedClient,
        isWebchatConnect: () => false,
      });
      expect(restartedRespond.mock.calls[0][1]).toMatchObject({
        operationId: descriptor.binding.operationId,
        state: "unknown",
      });
      expect(store.read(descriptor.binding.operationId).record.state).toBe("unknown");
      expect(mocks.agentCommand).toHaveBeenCalledTimes(1);

      const deniedDescriptor = structuredClone(descriptor);
      deniedDescriptor.binding.operationId = "00000000-0000-4000-8000-000000000023";
      deniedDescriptor.binding.runId = "00000000-0000-4000-8000-000000000024";
      deniedDescriptor.binding.sessionKey =
        "agent:legal-facts:legal:00000000-0000-4000-8000-000000000023";
      deniedDescriptor.bindingHash = evidenceHash(deniedDescriptor.binding);
      const deniedStore = new EngineEvidenceStore(path.join(stateDir, "quinn-legal-evidence-v1"));
      mocks.resolveSendPolicy.mockReturnValueOnce("deny");
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: path.join(stateDir, "sessions.json"),
        entry: {
          sessionId: "legal-session-denied",
          updatedAt: Date.now(),
          sendPolicy: "deny",
        },
        canonicalKey: deniedDescriptor.binding.sessionKey,
      });
      const deniedRespond = vi.fn();
      await invokeAgent(
        {
          ...request,
          sessionKey: deniedDescriptor.binding.sessionKey,
          idempotencyKey: deniedDescriptor.binding.operationId,
          legalEvidence: deniedDescriptor,
        },
        {
          respond: deniedRespond,
          context: ctx,
          client: authenticatedClient,
          isWebchatConnect: () => false,
        },
      );
      expect(deniedRespond.mock.calls[0][0]).toBe(false);
      expect(
        fs.existsSync(
          path.join(deniedStore.root, "operations", `${deniedDescriptor.binding.operationId}.json`),
        ),
      ).toBe(false);
      expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
      mocks.loadSessionEntry.mockReset();
      mocks.updateSessionStore.mockReset();
      mocks.agentCommand.mockReset();
      mocks.loadConfigReturn = {};
    }
  });

  it("preserves ACP metadata from the current stored session entry", async () => {
    const existingAcpMeta = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    };

    mockMainSessionEntry({
      acp: existingAcpMeta,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({ acp: existingAcpMeta }),
      };
      const result = await updater(store);
      capturedEntry = store["agent:main:main"] as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("test", "test-idem-acp-meta");

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.acp).toEqual(existingAcpMeta);
  });

  it("preserves cliSessionIds from existing session entry", async () => {
    const existingCliSessionIds = { "claude-cli": "abc-123-def" };
    const existingClaudeCliSessionId = "abc-123-def";

    mockMainSessionEntry({
      cliSessionIds: existingCliSessionIds,
      claudeCliSessionId: existingClaudeCliSessionId,
    });

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem");
    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.cliSessionIds).toEqual(existingCliSessionIds);
    expect(capturedEntry?.claudeCliSessionId).toBe(existingClaudeCliSessionId);
  });

  it("injects a timestamp into the message passed to agentCommand", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");

    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    await invokeAgent(
      {
        message: "Is it the weekend?",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-timestamp-inject",
      },
      { reqId: "ts-1" },
    );

    // Wait for the async agentCommand call
    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());

    const callArgs = mocks.agentCommand.mock.calls[0][0];
    expect(callArgs.message).toBe("[Wed 2026-01-28 20:30 EST] Is it the weekend?");

    resetTimeConfig();
  });

  it.each([
    {
      name: "passes senderIsOwner=false for write-scoped gateway callers",
      scopes: ["operator.write"],
      idempotencyKey: "test-sender-owner-write",
      senderIsOwner: false,
    },
    {
      name: "passes senderIsOwner=true for admin-scoped gateway callers",
      scopes: ["operator.admin"],
      idempotencyKey: "test-sender-owner-admin",
      senderIsOwner: true,
    },
  ])("$name", async ({ scopes, idempotencyKey, senderIsOwner }) => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "owner-tools check",
        sessionKey: "agent:main:main",
        idempotencyKey,
      },
      {
        client: {
          connect: {
            role: "operator",
            scopes,
            client: { id: "test-client", mode: "gateway" },
          },
        } as unknown as AgentHandlerArgs["client"],
      },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    expect(callArgs?.senderIsOwner).toBe(senderIsOwner);
  });

  it("respects explicit bestEffortDeliver=false for main session runs", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "strict delivery",
        agentId: "main",
        sessionKey: "agent:main:main",
        deliver: true,
        replyChannel: "telegram",
        to: "123",
        bestEffortDeliver: false,
        idempotencyKey: "test-strict-delivery",
      },
      { reqId: "strict-1" },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(callArgs.bestEffortDeliver).toBe(false);
  });

  it("only forwards workspaceDir for spawned subagent runs", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "normal run",
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/ignored",
        idempotencyKey: "workspace-ignored",
      },
      { reqId: "workspace-ignored-1" },
    );
    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const normalCall = mocks.agentCommand.mock.calls.at(-1)?.[0] as { workspaceDir?: string };
    expect(normalCall.workspaceDir).toBeUndefined();
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "spawned run",
        sessionKey: "agent:main:main",
        spawnedBy: "agent:main:subagent:parent",
        workspaceDir: "/tmp/inherited",
        idempotencyKey: "workspace-forwarded",
      },
      { reqId: "workspace-forwarded-1" },
    );
    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const spawnedCall = mocks.agentCommand.mock.calls.at(-1)?.[0] as { workspaceDir?: string };
    expect(spawnedCall.workspaceDir).toBe("/tmp/inherited");
  });

  it("keeps origin messageChannel as webchat while delivery channel uses last session channel", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "12345",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          lastChannel: "telegram",
          lastTo: "12345",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "webchat turn",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-webchat-origin-channel",
      },
      {
        reqId: "webchat-origin-1",
        client: {
          connect: {
            client: { id: "webchat-ui", mode: "webchat" },
          },
        } as AgentHandlerArgs["client"],
        isWebchatConnect: () => true,
      },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as {
      channel?: string;
      messageChannel?: string;
      runContext?: { messageChannel?: string };
    };
    expect(callArgs.channel).toBe("telegram");
    expect(callArgs.messageChannel).toBe("webchat");
    expect(callArgs.runContext?.messageChannel).toBe("webchat");
  });

  it("handles missing cliSessionIds gracefully", async () => {
    mockMainSessionEntry({});

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-2");
    expect(capturedEntry).toBeDefined();
    // Should be undefined, not cause an error
    expect(capturedEntry?.cliSessionIds).toBeUndefined();
    expect(capturedEntry?.claudeCliSessionId).toBeUndefined();
  });

  it("prunes legacy main alias keys when writing a canonical session entry", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {
        session: { mainKey: "work" },
        agents: { list: [{ id: "main", default: true }] },
      },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:work",
    });

    let capturedStore: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:work": { sessionId: "existing-session-id", updatedAt: 10 },
        "agent:main:MAIN": { sessionId: "legacy-session-id", updatedAt: 5 },
      };
      await updater(store);
      capturedStore = store;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "test",
        agentId: "main",
        sessionKey: "main",
        idempotencyKey: "test-idem-alias-prune",
      },
      { reqId: "3" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedStore).toBeDefined();
    expect(capturedStore?.["agent:main:work"]).toBeDefined();
    expect(capturedStore?.["agent:main:MAIN"]).toBeUndefined();
  });

  it("handles bare /new by resetting the same session and sending reset greeting prompt", async () => {
    mockSessionResetSuccess({ reason: "new" });

    primeMainAgentRun({ sessionId: "reset-session-id" });

    await invokeAgent(
      {
        message: "/new",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-new",
      },
      { reqId: "4" },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    expect(mocks.sessionsResetHandler).toHaveBeenCalledTimes(1);
    const call = readLastAgentCommandCall();
    // Message is now dynamically built with current date — check key substrings
    expect(call?.message).toContain("Execute your Session Startup sequence now");
    expect(call?.message).toContain("Current time:");
    expect(call?.message).not.toBe(BARE_SESSION_RESET_PROMPT);
    expect(call?.sessionId).toBe("reset-session-id");
  });

  it("uses /reset suffix as the post-reset message and still injects timestamp", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    mockSessionResetSuccess({ reason: "reset" });
    mocks.sessionsResetHandler.mockClear();
    primeMainAgentRun({
      sessionId: "reset-session-id",
      cfg: mocks.loadConfigReturn,
    });

    await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-reset-suffix",
      },
      { reqId: "4b" },
    );

    const call = await expectResetCall("[Wed 2026-01-28 20:30 EST] check status");
    expect(call?.sessionId).toBe("reset-session-id");

    resetTimeConfig();
  });

  it("rejects malformed agent session keys early in agent handler", async () => {
    mocks.agentCommand.mockClear();
    const respond = await invokeAgent(
      {
        message: "test",
        sessionKey: "agent:main",
        idempotencyKey: "test-malformed-session-key",
      },
      { reqId: "4" },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed session key"),
      }),
    );
  });

  it("rejects malformed session keys in agent.identity.get", async () => {
    const respond = await invokeAgentIdentityGet(
      {
        sessionKey: "agent:main",
      },
      { reqId: "5" },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed session key"),
      }),
    );
  });
});

for (const outcome of ["success", "failure"] as const) {
  it(`strict legal ${outcome} releases active ownership and never forwards private work`, async () => {
    const previous = process.env.OPENCLAW_STATE_DIR;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quinn-astra-handler-"));
    process.env.OPENCLAW_STATE_DIR = root;
    const descriptor = structuredClone(evidenceFixtures.records.capture) as CaptureRequest;
    const runtime = structuredClone(
      evidenceFixtures.records.engine.record.runtime,
    ) as RuntimeIdentity;
    const message = "DEVELOPMENT private legal assignment";
    descriptor.binding.operationId = "00000000-0000-4000-8000-000000000091";
    descriptor.binding.sessionKey = `agent:legal-facts:legal:${descriptor.binding.operationId}`;
    descriptor.binding.submittedPromptHash = bytesHash(message);
    descriptor.binding.modelPolicyHash = LEGAL_EVIDENCE_MODEL_POLICY_HASH;
    descriptor.binding.deadlineAt = new Date(Date.now() + 300_000).toISOString();
    descriptor.bindingHash = evidenceHash(descriptor.binding);
    const ctx = {
      ...makeContext(),
      legalEvidenceReadRuntime: () => structuredClone(runtime),
    } as GatewayRequestContext;
    const respond = vi.fn();
    mocks.maybeEmitOutcome.mockClear();
    mocks.loadConfigReturn = {};
    mocks.resolveSendPolicy.mockReturnValue("allow");
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: path.join(root, "sessions.json"),
      entry: { sessionId: "development-legal", updatedAt: Date.now() },
      canonicalKey: descriptor.binding.sessionKey,
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      await updater({});
    });
    mocks.agentCommand.mockReset();
    if (outcome === "success") {
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "DEVELOPMENT private legal output" }],
      });
    } else {
      mocks.agentCommand.mockRejectedValue(new Error("DEVELOPMENT failure before candidate"));
    }
    try {
      await invokeAgent(
        {
          message,
          agentId: "legal-facts",
          sessionKey: descriptor.binding.sessionKey,
          thinking: "high",
          deliver: false,
          idempotencyKey: descriptor.binding.operationId,
          legalEvidence: descriptor,
        } as AgentParams,
        {
          respond,
          context: ctx,
          client: {
            authenticatedDeviceId: "development-device",
            connect: {
              role: "operator",
              scopes: ["operator.read", "operator.write"],
              client: { id: "mission-control-cli", mode: "cli" },
            },
          } as never,
          isWebchatConnect: () => false,
        },
      );
      await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
      expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
      expect(mocks.maybeEmitOutcome).not.toHaveBeenCalled();
      expect(ctx.legalEvidenceActiveOperationIds?.size).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previous;
      }
      fs.rmSync(root, { recursive: true, force: true });
      mocks.agentCommand.mockReset();
    }
  });
}

it("ordinary agent success retains its existing outcome hook", async () => {
  mocks.maybeEmitOutcome.mockClear();
  mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "ordinary development output" }] });
  await runMainAgent("ordinary development assignment", "astra-ordinary-outcome");
  await vi.waitFor(() => expect(mocks.maybeEmitOutcome).toHaveBeenCalledTimes(1));
});
