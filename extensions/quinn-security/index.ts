import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { bridgeEvaluate } from "./src/bridge.js";

export default function register(api: OpenClawPluginApi) {
  const baseUrl = process.env.QUINN_SECURITY_BRIDGE_URL ?? "http://127.0.0.1:4242";

  api.on("before_tool_call", async (event, ctx) => {
    const decision = await bridgeEvaluate(baseUrl, {
      agentId: ctx.agentId ?? "unknown",
      action: `tool:${event.toolName}`,
      input: JSON.stringify(event.params ?? {}),
    });
    if (!decision.allowed) {
      return { block: true, blockReason: decision.blockReason ?? "blocked by security pipeline" };
    }
    return undefined;
  });

  api.on("message_sending", async (event, ctx) => {
    // PluginHookMessageContext carries no agentId (it's channel-scoped), so
    // outbound gating is agent-agnostic in Phase 1 — evaluate against the
    // channel/account instead of pretending we know the agent.
    const decision = await bridgeEvaluate(baseUrl, {
      agentId: ctx.accountId ?? ctx.channelId ?? "unknown",
      action: "message_sending",
      input: event.content,
      target: event.to,
    });
    if (!decision.allowed) {
      api.logger?.warn?.(
        `quinn-security cancelled an outbound message: ${decision.blockReason ?? "blocked by security pipeline"}`,
      );
      return { cancel: true };
    }
    return undefined;
  });
}
