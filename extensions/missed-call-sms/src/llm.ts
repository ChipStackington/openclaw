/**
 * SMS LLM completion via the core's embedded pi-agent.
 *
 * Mirrors voice-call/src/response-generator.ts: per-caller session keyed
 * `sms:<digits>`, agentId "main", model from config modelRef. The core
 * resolves provider auth (Codex OAuth incl. refresh) — this plugin holds
 * no credentials.
 */

import crypto from "node:crypto";
import { loadCoreAgentDeps, type CoreConfig } from "./core-bridge.js";

export type SmsLlmComplete = (args: {
  systemPrompt: string;
  prompt: string;
  callerPhone: string;
}) => Promise<string>;

export function parseModelRef(
  modelRef: string,
  defaults: { provider: string; model: string },
): { provider: string; model: string } {
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex === -1) return { provider: defaults.provider, model: modelRef };
  return { provider: modelRef.slice(0, slashIndex), model: modelRef.slice(slashIndex + 1) };
}

export function extractPayloadText(
  payloads?: Array<{ text?: string; isError?: boolean }>,
): string {
  if (!payloads) return "";
  return payloads
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

type SessionEntry = { sessionId: string; updatedAt: number };

export function createPiAgentCompleter(opts: {
  modelRef: string;
  coreConfig: CoreConfig;
}): SmsLlmComplete {
  const { modelRef, coreConfig } = opts;

  return async ({ systemPrompt, prompt, callerPhone }) => {
    const deps = await loadCoreAgentDeps();
    const agentId = "main";
    const normalizedPhone = callerPhone.replace(/\D/g, "");
    const sessionKey = `sms:${normalizedPhone}`;

    const storePath = deps.resolveStorePath(coreConfig.session?.store, { agentId });
    const agentDir = deps.resolveAgentDir(coreConfig, agentId);
    const workspaceDir = deps.resolveAgentWorkspaceDir(coreConfig, agentId);
    await deps.ensureAgentWorkspace({ dir: workspaceDir });

    const sessionStore = deps.loadSessionStore(storePath);
    let sessionEntry = sessionStore[sessionKey] as SessionEntry | undefined;
    if (!sessionEntry) {
      sessionEntry = { sessionId: crypto.randomUUID(), updatedAt: Date.now() };
      sessionStore[sessionKey] = sessionEntry;
      await deps.saveSessionStore(storePath, sessionStore);
    }
    const sessionFile = deps.resolveSessionFilePath(sessionEntry.sessionId, sessionEntry, {
      agentId,
    });

    const { provider, model } = parseModelRef(modelRef, {
      provider: deps.DEFAULT_PROVIDER,
      model: deps.DEFAULT_MODEL,
    });
    const thinkLevel = deps.resolveThinkingDefault({ cfg: coreConfig, provider, model });
    const timeoutMs = deps.resolveAgentTimeoutMs({ cfg: coreConfig });

    const result = await deps.runEmbeddedPiAgent({
      sessionId: sessionEntry.sessionId,
      sessionKey,
      messageProvider: "sms",
      sessionFile,
      workspaceDir,
      config: coreConfig,
      prompt,
      provider,
      model,
      thinkLevel,
      verboseLevel: "off",
      timeoutMs,
      runId: `sms:${normalizedPhone}:${Date.now()}`,
      lane: "sms",
      extraSystemPrompt: systemPrompt,
      agentDir,
    });

    if (result.meta?.aborted) throw new Error("sms llm run aborted");
    const text = extractPayloadText(result.payloads);
    if (!text) throw new Error("sms llm returned no text");
    return text;
  };
}
