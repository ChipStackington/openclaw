/**
 * Run-eligibility rules. Hook contexts expose NO lane/spawnedBy fields —
 * subagent/cron runs are recognized by sessionKey shape (same convention
 * as core's session-key-utils), sms/voice by messageProvider or key prefix.
 * agent_end's ctx has no `trigger`, so extraction relies on key rules only.
 */

export type RunCtx = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  trigger?: string;
};

function keyHas(sessionKey: string | undefined, marker: string): boolean {
  const key = (sessionKey ?? "").toLowerCase();
  return key.startsWith(`${marker}:`) || key.includes(`:${marker}:`);
}

export function isEligibleRun(ctx: RunCtx): boolean {
  // Never import organization memory or export legal evidence to its extractor.
  if (keyHas(ctx.sessionKey, "legal")) return false;
  if (keyHas(ctx.sessionKey, "subagent")) return false;
  if (keyHas(ctx.sessionKey, "cron")) return false;
  if (ctx.messageProvider === "sms" || keyHas(ctx.sessionKey, "sms")) return false;
  if (ctx.messageProvider === "voice" || keyHas(ctx.sessionKey, "voice")) return false;
  return true;
}

export function shouldInject(ctx: RunCtx): boolean {
  if (!isEligibleRun(ctx)) return false;
  if (ctx.trigger && ctx.trigger !== "user") return false;
  return true;
}

type TextBlock = { type?: string; text?: string };

export function toRoleTextPairs(
  messages: unknown[],
  maxChars = 24_000,
): Array<{ role: string; text: string }> {
  // Core hands us the FULL session snapshot, not the turn delta, so once a
  // session exceeds the char budget we must keep the NEWEST messages (tail)
  // and drop/truncate the OLDEST ones — otherwise long-running sessions
  // freeze on stale content and new facts never reach extraction. Walk the
  // array backwards to prefer the tail, then reverse to restore chronology.
  const pairs: Array<{ role: string; text: string }> = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (used >= maxChars) break;
    const raw = messages[i];
    if (typeof raw !== "object" || raw === null) continue;
    const msg = raw as { role?: string; content?: unknown };
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = (msg.content as TextBlock[])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
    }
    text = text.trim();
    if (!text) continue;
    const remaining = maxChars - used;
    if (text.length > remaining) text = text.slice(text.length - remaining);
    used += text.length;
    pairs.push({ role: msg.role, text });
  }
  pairs.reverse();
  return pairs;
}
