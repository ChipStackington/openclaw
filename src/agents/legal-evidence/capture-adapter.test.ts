import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { test, vi } from "vitest";
import { LegalEvidenceCapture } from "./capture.js";
import fixtures from "./development-fixtures.json" with { type: "json" };
import { bytesHash, evidenceHash } from "./hash.js";
import { EngineEvidenceStore } from "./store.js";
import type { EngineReceipt } from "./types.js";
const adapterRoot = process.env.B2_ADAPTER_ROOT
  ? path.resolve(process.env.B2_ADAPTER_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@mariozechner/pi-ai"))), "..");
const stream = (
  await import(
    pathToFileURL(path.join(adapterRoot, "dist/providers/openai-codex-responses.js")).href
  )
).streamSimpleOpenAICodexResponses as unknown as StreamFn;
const model: Model<"openai-codex-responses"> = {
  id: "gpt-6.1-sol",
  name: "offline",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 32000,
};
const key =
  "x." +
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } }),
  ).toString("base64url") +
  ".x";
const text = '{"offline":"é 🚀"}';
const item = {
  id: "msg_offline",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
};
const terminal = {
  type: "response.completed",
  response: { id: "resp_offline", model: model.id, status: "completed", output: [item] },
};
const encode = (event: unknown) => Buffer.from("data: " + JSON.stringify(event) + "\r\n\r\n");
const wire = Buffer.concat(
  [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.content_part.added", part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.output_item.done", item },
    terminal,
  ].map(encode),
);
function operationWire(owner: string) {
  const operationText = JSON.stringify({ capturedFor: owner });
  const operationItem = {
    ...item,
    id: `msg_${owner}`,
    content: [{ type: "output_text", text: operationText }],
  };
  const operationTerminal = {
    type: "response.completed",
    response: {
      id: `resp_${owner}`,
      model: model.id,
      status: "completed",
      output: [operationItem],
    },
  };
  return {
    text: operationText,
    bytes: Buffer.concat(
      [
        { type: "response.output_item.added", item: { ...operationItem, content: [] } },
        {
          type: "response.content_part.added",
          part: { type: "output_text", text: "" },
        },
        { type: "response.output_text.delta", delta: operationText },
        { type: "response.output_item.done", item: operationItem },
        operationTerminal,
      ].map(encode),
    ),
  };
}
function setup(onFinished: (fn: () => void) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legal-b2-adapter-"));
  onFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new EngineEvidenceStore(root),
    r = structuredClone(fixtures.records.engine.record) as EngineReceipt;
  r.operationId = randomUUID();
  r.binding.operationId = r.operationId;
  r.preparedAt = new Date().toISOString();
  r.binding.deadlineAt = new Date(Date.now() + 60_000).toISOString();
  r.binding.submittedPromptHash = bytesHash("offline");
  r.bindingHash = evidenceHash(r.binding);
  r.state = "prepared";
  r.events = [];
  r.attempts = [];
  r.journal = store.putBlob("journal", Buffer.from("[]"));
  for (const k of ["endedAt", "selectedAttemptId", "executionSummary", "holdReason"] as const) {
    delete r[k];
  }
  const capture = LegalEvidenceCapture.create(store, r, "offline", () =>
    structuredClone(r.runtime),
  );
  capture.candidate("openai-codex", model.id, "high");
  capture.runnerStarted("openai-codex", model.id, "high");
  return { store, r, capture };
}
const response = (bytes: Uint8Array = wire, status = 200) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) {
          c.enqueue(bytes.slice(i, i + 3));
        }
        c.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream" } },
  );
const run = (capture: LegalEvidenceCapture, options: Record<string, unknown> = {}) => {
  const result = capture.wrapStream(stream)(
    model,
    { messages: [{ role: "user", content: "offline", timestamp: 0 }] },
    { apiKey: key, reasoning: "high", ...options },
  );
  return Promise.resolve(result).then((value) => value.result());
};
test("actual patched adapter commits exact mutated body before mocked fetch, then seals exact original stream", async ({
  onTestFinished,
}) => {
  const { store, r, capture } = setup(onTestFinished);
  let calls = 0;
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    calls++;
    const saved = store.read(r.operationId).record;
    assert.equal(saved.attempts.length, 1);
    assert.equal(saved.attempts[0].state, "send-intent");
    assert.equal(store.readBlob(saved.attempts[0].requestBody).toString(), init.body);
    assert.equal(init.redirect, "manual");
    return response();
  });
  const result = await run(capture, {
    onPayload: async (body: Record<string, unknown>) => ({ ...body, offline_nonce: "final" }),
  });
  assert.equal(result.stopReason, "stop");
  capture.finishRunner({
    aborted: false,
    compactions: 0,
    toolCalls: 0,
    messagingSends: 0,
    continuations: capture.providerContinuations,
    thinkingDowngrades: 0,
    authRotations: 0,
  });
  const saved = new EngineEvidenceStore(store.root).read(r.operationId).record;
  assert.equal(saved.state, "completed");
  assert.equal(saved.captureOrigin, "development-fixture");
  assert.deepEqual(store.readBlob(saved.attempts[0].responseStream!), wire);
  assert.deepEqual(store.readBlob(saved.attempts[0].terminal!.frame), encode(terminal));
  assert.equal(store.readBlob(saved.attempts[0].providerText!).toString(), text);
  assert.equal(calls, 1);
  assert.throws(() =>
    LegalEvidenceCapture.create(store, r, "offline", () => structuredClone(r.runtime)),
  );
});
test("simultaneous actual adapter streams stay bound to their own operation", async ({
  onTestFinished,
}) => {
  const left = setup(onTestFinished);
  const right = setup(onTestFinished);
  const leftWire = operationWire("left");
  const rightWire = operationWire("right");
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    if (typeof init.body !== "string") {
      throw new Error("adapter request body was not serialized text");
    }
    const body = JSON.parse(init.body) as { owner?: string };
    const result = body.owner === "left" ? leftWire : rightWire;
    return response(result.bytes);
  });
  const [leftResult, rightResult] = await Promise.all([
    run(left.capture, {
      onPayload: (body: Record<string, unknown>) => ({ ...body, owner: "left" }),
    }),
    run(right.capture, {
      onPayload: (body: Record<string, unknown>) => ({ ...body, owner: "right" }),
    }),
  ]);
  assert.equal(leftResult.stopReason, "stop");
  assert.equal(rightResult.stopReason, "stop");
  for (const capture of [left.capture, right.capture]) {
    capture.finishRunner({
      aborted: false,
      compactions: 0,
      toolCalls: 0,
      messagingSends: 0,
      continuations: capture.providerContinuations,
      thinkingDowngrades: 0,
      authRotations: 0,
    });
  }
  const leftSaved = left.store.read(left.r.operationId).record;
  const rightSaved = right.store.read(right.r.operationId).record;
  assert.equal(leftSaved.state, "completed");
  assert.equal(rightSaved.state, "completed");
  assert.equal(
    left.store.readBlob(leftSaved.attempts[0].requestBody).toString().includes('"owner":"left"'),
    true,
  );
  assert.equal(
    right.store.readBlob(rightSaved.attempts[0].requestBody).toString().includes('"owner":"right"'),
    true,
  );
  assert.deepEqual(left.store.readBlob(leftSaved.attempts[0].responseStream!), leftWire.bytes);
  assert.deepEqual(right.store.readBlob(rightSaved.attempts[0].responseStream!), rightWire.bytes);
  assert.equal(left.store.readBlob(leftSaved.attempts[0].providerText!).toString(), leftWire.text);
  assert.equal(
    right.store.readBlob(rightSaved.attempts[0].providerText!).toString(),
    rightWire.text,
  );
});
test("actual adapter refuses media introduced by final payload mutation before fetch", async ({
  onTestFinished,
}) => {
  const { store, r, capture } = setup(onTestFinished);
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return response();
  });
  const result = await run(capture, {
    onPayload: (body: Record<string, unknown>) => ({
      ...body,
      input: [
        {
          role: "user",
          content: { type: "input_image", image_url: "data:image/png;base64,AA==" },
        },
      ],
    }),
  });
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "legal-evidence-held");
  assert.equal(calls, 0);
  const saved = store.read(r.operationId).record;
  assert.equal(saved.attempts.length, 0);
  assert.equal(saved.state, "failed");
});
test("actual adapter refuses a changed submitted assignment before fetch", async ({
  onTestFinished,
}) => {
  const { store, r, capture } = setup(onTestFinished);
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return response();
  });
  const result = await run(capture, {
    onPayload: (body: Record<string, unknown>) => ({
      ...body,
      input: [{ role: "user", content: [{ type: "input_text", text: "changed" }] }],
    }),
  });
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "legal-evidence-held");
  assert.equal(calls, 0);
  assert.equal(store.read(r.operationId).record.attempts.length, 0);
});
for (const kind of ["429", "redirect", "network", "duplicate", "wrong-model"]) {
  test(
    "actual adapter " + kind + " stays held with one permanent reservation",
    async ({ onTestFinished }) => {
      const { store, r, capture } = setup(onTestFinished);
      let calls = 0;
      vi.stubGlobal("fetch", async () => {
        calls++;
        if (kind === "network") {
          throw Error("PRIVATE_TRANSPORT_DETAIL");
        }
        return response(
          kind === "duplicate"
            ? Buffer.concat([wire, encode(terminal)])
            : kind === "wrong-model"
              ? encode({ ...terminal, response: { ...terminal.response, model: "gpt-6-astra" } })
              : wire,
          kind === "429" ? 429 : kind === "redirect" ? 302 : 200,
        );
      });
      const result = await run(capture);
      assert.equal(result.stopReason, "error");
      assert.equal(result.errorMessage, "legal-evidence-held");
      assert.equal(calls, 1);
      const saved = store.read(r.operationId).record;
      assert.equal(saved.attempts.length, 1);
      assert.notEqual(saved.state, "completed");
      assert.throws(() =>
        LegalEvidenceCapture.create(store, r, "offline", () => structuredClone(r.runtime)),
      );
    },
  );
}
test("final effort mismatch is held before any HTTP call", async ({ onTestFinished }) => {
  const { store, r, capture } = setup(onTestFinished);
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return response();
  });
  const result = await run(capture, { reasoning: "medium" });
  assert.equal(result.stopReason, "error");
  assert.equal(calls, 0);
  assert.equal(store.read(r.operationId).record.attempts.length, 0);
  assert.throws(() =>
    LegalEvidenceCapture.create(store, r, "offline", () => structuredClone(r.runtime)),
  );
});
test("uncertain request storage consumes logical operation without sending or replaying", async ({
  onTestFinished,
}) => {
  const { store, r, capture } = setup(onTestFinished);
  const commit = store.commit.bind(store);
  store.commit = () => {
    throw Error("PRIVATE_DISK_PATH");
  };
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return response();
  });
  const result = await run(capture);
  assert.equal(result.stopReason, "error");
  assert.equal(calls, 0);
  store.commit = commit;
  assert.throws(() =>
    LegalEvidenceCapture.create(store, r, "offline", () => structuredClone(r.runtime)),
  );
});
