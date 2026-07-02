import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
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
    const decision = await bridgeEvaluate(baseUrl, {
      agentId: (ctx as any).agentId ?? "unknown",
      action: "message_sending",
      input: event.content,
      target: event.to,
    });
    if (!decision.allowed) {
      return { cancel: true };
    }
    return undefined;
  });
}
