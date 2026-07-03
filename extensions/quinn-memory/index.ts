import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { fetchMemoryBlock, postExtract } from "./src/bridge.js";
import { isEligibleRun, shouldInject, toRoleTextPairs, type RunCtx } from "./src/filters.js";

export default function register(api: OpenClawPluginApi) {
  if (process.env.QUINN_MEMORY_DISABLED === "1") return;
  const baseUrl = process.env.QUINN_MEMORY_BRIDGE_URL ?? "http://127.0.0.1:4242";
  const orgId = process.env.QUINN_MEMORY_ORG_ID ?? "org-001";

  api.on("before_agent_start", async (event, ctx) => {
    const runCtx = ctx as RunCtx;
    if (!shouldInject(runCtx)) return undefined;
    const block = await fetchMemoryBlock(baseUrl, {
      orgId,
      agentId: runCtx.agentId ?? "unknown",
      prompt: event.prompt,
    });
    if (!block) return undefined;
    return { prependContext: block };
  });

  api.on("agent_end", async (event, ctx) => {
    if (!event.success) return;
    const runCtx = ctx as RunCtx;
    if (!isEligibleRun(runCtx)) return;
    const messages = toRoleTextPairs(event.messages);
    if (!messages.some((m) => m.role === "user")) return;
    void postExtract(baseUrl, {
      orgId,
      agentId: runCtx.agentId ?? "unknown",
      sessionId: runCtx.sessionId ?? "unknown",
      messages,
    });
  });
}
