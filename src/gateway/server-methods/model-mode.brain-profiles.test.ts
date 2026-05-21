import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelModeHandlers } from "./model-mode.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshotForWrite: vi.fn(),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
  writeConfigFile: mocks.writeConfigFile,
}));

vi.mock("../../config/validation.js", () => ({
  validateConfigObjectWithPlugins: (config: unknown) => ({ ok: true, config }),
}));

vi.mock("../control-plane-audit.js", () => ({
  resolveControlPlaneActor: () => ({ actor: "test" }),
  formatControlPlaneActor: () => "actor=test",
}));

function captureRespond() {
  const calls: Array<{ ok: boolean; payload: unknown; error: unknown }> = [];
  return {
    calls,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  };
}

function context() {
  return { logGateway: { info: vi.fn() } };
}

describe("model-mode brain profiles", () => {
  let tempStateDir = "";
  let previousStateDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-mode-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    mocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        valid: true,
        config: {
          agents: {
            defaults: { model: "anthropic/claude-haiku-4-5-20251001", models: {} },
            list: [{ id: "quinn", model: "anthropic/claude-haiku-4-5-20251001" }],
          },
        },
      },
      writeOptions: {},
    });
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  });

  it("returns public-safe brain metadata from get", async () => {
    const { calls, respond } = captureRespond();

    await modelModeHandlers["model-mode.get"]({ respond } as never);

    expect(calls[0].ok).toBe(true);
    expect(calls[0].payload).toMatchObject({
      globalMode: "einstein",
      tierRouting: expect.any(Object),
      brainProfiles: expect.any(Object),
      tiers: {
        economy: expect.objectContaining({
          label: "Economy Mode",
          modelRef: "openai/gpt-5.4-mini",
          provider: "openai",
          billing: "metered",
        }),
        baller: expect.objectContaining({
          label: "Executive Mode",
          modelRef: "openai-codex/gpt-5.4",
          provider: "openai-codex",
          auth: "oauth",
          billing: "subscription",
        }),
        einstein: expect.objectContaining({
          label: "Einstein Mode",
          modelRef: "openai-codex/gpt-5.5",
          provider: "openai-codex",
          billing: "subscription",
        }),
      },
    });
  });

  it("set writes resolved configured brain profile model refs", async () => {
    const { calls, respond } = captureRespond();

    await modelModeHandlers["model-mode.set"]({
      params: { mode: "einstein" },
      respond,
      client: {},
      context: context(),
    } as never);

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            model: "openai-codex/gpt-5.5",
          }),
        }),
      }),
      {},
    );
    expect(calls[0]).toMatchObject({
      ok: true,
      payload: expect.objectContaining({
        ok: true,
        globalMode: "einstein",
        modelRef: "openai-codex/gpt-5.5",
        billing: "subscription",
      }),
    });
  });

  it("agent-set writes per-agent resolved model refs", async () => {
    const { calls, respond } = captureRespond();

    await modelModeHandlers["model-mode.agent-set"]({
      params: { agentId: "quinn", mode: "einstein" },
      respond,
      client: {},
      context: context(),
    } as never);

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          list: [expect.objectContaining({ id: "quinn", model: "openai-codex/gpt-5.5" })],
        }),
      }),
      {},
    );
    expect(calls[0]).toMatchObject({
      ok: true,
      payload: expect.objectContaining({
        agentId: "quinn",
        effectiveModel: "openai-codex/gpt-5.5",
      }),
    });
  });
});
