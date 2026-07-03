import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEngine } from "./src/agent.js";
import { MissedCallSmsConfigSchema, type MissedCallSmsConfig } from "./src/config.js";
import { MissedCallSmsStore } from "./src/store.js";

const noopLogger = { info() {}, warn() {}, error() {} };

function makeConfig(): MissedCallSmsConfig {
  const cfg = MissedCallSmsConfigSchema.parse({
    business: {
      name: "Testy Pizza",
      greeting: "g",
      hoursText: "Mon-Fri 9-5",
      faq: [{ q: "Do you deliver?", a: "Yes, within 5 miles." }],
      bookingUrl: "https://book.example.com",
      escalationPhone: "+15559990000",
    },
    telnyx: { fromNumber: "+15550001111" },
  });
  return cfg;
}

function makeFakeTelnyx() {
  const sent: Array<{ to: string; text: string }> = [];
  return {
    sent,
    async send(msg: { to: string; text: string }) {
      sent.push(msg);
      return { messageId: `m${sent.length}` };
    },
  };
}

// Adapted for the real store API: MissedCallSmsStore has no `setVoicemail`
// method — voicemail is attached via `attachVoicemail(conversationId,
// voicemail: VoicemailRecord)`, and VoicemailRecord requires a mandatory
// `capturedAt` ISO timestamp (the brief's test omitted it).
function attachVoicemail(
  store: MissedCallSmsStore,
  conversationId: string,
  voicemail: { transcript: string; transcriptConfidence: number },
) {
  return store.attachVoicemail(conversationId, {
    ...voicemail,
    capturedAt: new Date().toISOString(),
  });
}

describe("AgentEngine (codex completer)", () => {
  let dir: string;
  let store: MissedCallSmsStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcs-agent-"));
    store = new MissedCallSmsStore(path.join(dir, "store.jsonl"));
    await store.init();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function makeEngine(replies: string[], telnyx = makeFakeTelnyx()) {
    const calls: Array<{ systemPrompt: string; prompt: string; callerPhone: string }> = [];
    const engine = new AgentEngine({
      config: makeConfig(),
      store,
      telnyxSms: telnyx as never,
      logger: noopLogger,
      llmComplete: async (args) => {
        calls.push(args);
        return replies[Math.min(calls.length - 1, replies.length - 1)]!;
      },
    });
    return { engine, calls, telnyx };
  }

  it("first turn: sends [SEND] reply, passes voicemail as prompt, FAQ in system prompt", async () => {
    const convo = await store.getOrCreate("+15551234567", "+15550001111");
    await attachVoicemail(store, convo.id, {
      transcript: "Hi, do you deliver to Uxbridge?",
      transcriptConfidence: 0.95,
    });
    const { engine, calls, telnyx } = makeEngine(["[SEND] Yes we deliver! Book: https://book.example.com"]);

    const result = await engine.handleVoicemail(convo.id);

    expect(result.success).toBe(true);
    expect(result.reply).toContain("Yes we deliver");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("do you deliver to Uxbridge");
    expect(calls[0]!.systemPrompt).toContain("Testy Pizza");
    expect(calls[0]!.systemPrompt).toContain("Do you deliver?");
    expect(calls[0]!.systemPrompt).toContain("FIRST text");
    expect(telnyx.sent).toHaveLength(1);
    expect(telnyx.sent[0]!.to).toBe("+15551234567");
    const after = await store.getConversation(convo.id);
    expect(after!.status).toBe("awaiting-reply");
    expect(after!.agentTurnCount).toBe(1);
  });

  it("follow-up: history rides in systemPrompt, latest caller text is the prompt", async () => {
    const convo = await store.getOrCreate("+15551234567", "+15550001111");
    await attachVoicemail(store, convo.id, { transcript: "First voicemail", transcriptConfidence: 0.9 });
    await store.appendMessage(convo.id, { role: "agent", content: "Earlier agent reply" });
    const { engine, calls } = makeEngine(["[SEND] Follow-up answer"]);

    const result = await engine.handleInboundSms("+15551234567", "What time do you close?");

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe("What time do you close?");
    expect(calls[0]!.systemPrompt).toContain("First voicemail");
    expect(calls[0]!.systemPrompt).toContain("Earlier agent reply");
    expect(calls[0]!.systemPrompt).not.toContain("FIRST text");
  });

  it("[ESCALATE] sets status, texts caller handoff, texts owner", async () => {
    const convo = await store.getOrCreate("+15551234567", "+15550001111");
    await attachVoicemail(store, convo.id, { transcript: "vm", transcriptConfidence: 0.9 });
    const { engine, telnyx } = makeEngine(["[ESCALATE] pricing dispute"]);

    const result = await engine.handleVoicemail(convo.id);

    expect(result.newStatus).toBe("escalated");
    const after = await store.getConversation(convo.id);
    expect(after!.status).toBe("escalated");
    const tos = telnyx.sent.map((s) => s.to);
    expect(tos).toContain("+15551234567"); // caller handoff
    expect(tos).toContain("+15559990000"); // owner notify
  });

  it("[CLOSE] closes without sending", async () => {
    const convo = await store.getOrCreate("+15551234567", "+15550001111");
    await attachVoicemail(store, convo.id, { transcript: "vm", transcriptConfidence: 0.9 });
    const { engine, telnyx } = makeEngine(["[CLOSE] resolved"]);

    const result = await engine.handleVoicemail(convo.id);

    expect(result.newStatus).toBe("closed");
    expect(telnyx.sent).toHaveLength(0);
  });

  it("off-format reply is treated as SEND", async () => {
    const convo = await store.getOrCreate("+15551234567", "+15550001111");
    await attachVoicemail(store, convo.id, { transcript: "vm", transcriptConfidence: 0.9 });
    const { engine, telnyx } = makeEngine(["Plain reply without a marker"]);

    const result = await engine.handleVoicemail(convo.id);

    expect(result.success).toBe(true);
    expect(telnyx.sent[0]!.text).toBe("Plain reply without a marker");
  });

  it("escalation keyword skips the LLM entirely", async () => {
    const { engine, calls } = makeEngine(["[SEND] should never be used"]);

    const result = await engine.handleInboundSms("+15557778888", "I want to speak to a real person");

    expect(result.newStatus).toBe("escalated");
    expect(calls).toHaveLength(0);
  });

  it("LLM failure returns success:false and sends nothing", async () => {
    const convo = await store.getOrCreate("+15551234567", "+15550001111");
    await attachVoicemail(store, convo.id, { transcript: "vm", transcriptConfidence: 0.9 });
    const telnyx = makeFakeTelnyx();
    const engine = new AgentEngine({
      config: makeConfig(),
      store,
      telnyxSms: telnyx as never,
      logger: noopLogger,
      llmComplete: async () => {
        throw new Error("codex down");
      },
    });

    const result = await engine.handleVoicemail(convo.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain("codex down");
    expect(telnyx.sent).toHaveLength(0);
  });
});
