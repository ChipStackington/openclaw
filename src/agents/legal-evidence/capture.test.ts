import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  LegalEvidenceCapture,
  projectLegalTerminal,
  applyLegalCaptureSettings,
} from "./capture.js";
import fixtures from "./development-fixtures.json" with { type: "json" };
import { evidenceHash } from "./hash.js";
import { EngineEvidenceStore } from "./store.js";
import type { EngineReceipt, ExecutionSummary } from "./types.js";
const clean: ExecutionSummary = {
  aborted: false,
  compactions: 0,
  toolCalls: 0,
  messagingSends: 0,
  continuations: 0,
  thinkingDowngrades: 0,
  authRotations: 0,
};
test("retry and compaction overrides are per-run and never use persistent setters", () => {
  let overrides: unknown;
  applyLegalCaptureSettings({
    applyOverrides: (value) => {
      overrides = value;
    },
  });
  assert.deepEqual(overrides, { retry: { enabled: false }, compaction: { enabled: false } });
});
const text = '{"complete":"é 🚀"}';
function frame(change: Record<string, unknown> = {}) {
  return Buffer.from(
    "data: " +
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_offline",
          model: "gpt-6.1-sol",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text }],
            },
          ],
          ...change,
        },
      }) +
      "\r\n\r\n",
  );
}
function prepared(store: EngineEvidenceStore): EngineReceipt {
  const r = structuredClone(fixtures.records.engine.record) as EngineReceipt;
  r.operationId = randomUUID();
  r.binding.operationId = r.operationId;
  r.preparedAt = new Date().toISOString();
  r.binding.deadlineAt = new Date(Date.now() + 60_000).toISOString();
  r.bindingHash = evidenceHash(r.binding);
  r.state = "prepared";
  r.events = [];
  r.attempts = [];
  r.journal = store.putBlob("journal", Buffer.from("[]"));
  for (const k of ["endedAt", "selectedAttemptId", "executionSummary", "holdReason"] as const) {
    delete r[k];
  }
  return r;
}
function setup(onFinished: (fn: () => void) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legal-b2-"));
  onFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new EngineEvidenceStore(root),
    r = prepared(store);
  return { store, r, capture: LegalEvidenceCapture.create(store, r) };
}
const request = {
  body: JSON.stringify({
    model: "gpt-6.1-sol",
    reasoning: { effort: "high" },
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: "offline" }] }],
  }),
  url: "https://chatgpt.com/backend-api/codex/responses",
  method: "POST" as const,
  transport: "sse" as const,
  model: "gpt-6.1-sol",
  provider: "openai-codex",
  httpAttemptIndex: 0,
};
test("capture reserves exact bytes durably before send, never refunds across restart", async ({
  onTestFinished,
}) => {
  const { store, r, capture } = setup(onTestFinished);
  capture.candidate("openai-codex", "gpt-6.1-sol", "high");
  capture.runnerStarted();
  await capture.observer.onRequest(request);
  const saved = new EngineEvidenceStore(store.root).read(r.operationId).record;
  assert.equal(saved.attempts.length, 1);
  assert.equal(saved.attempts[0].state, "send-intent");
  assert.equal(store.readBlob(saved.attempts[0].requestBody).toString(), request.body);
  assert.throws(() => LegalEvidenceCapture.create(store, r));
  await assert.rejects(() => capture.observer.onRequest(request));
  assert.equal(store.read(r.operationId).record.attempts.length, 1);
});
for (const change of [
  { body: '{"model":"gpt-6-astra","reasoning":{"effort":"high"},"stream":true}' },
  { body: '{"model":"gpt-6.1-sol","reasoning":{"effort":"medium"},"stream":true}' },
  { httpAttemptIndex: 1 },
  { url: "https://other.example" },
  { body: '{"model":"gpt-6.1-sol","reasoning":{"effort":"high"},"stream":false}' },
  {
    body: JSON.stringify({
      model: "gpt-6.1-sol",
      reasoning: { effort: "high" },
      stream: true,
      tools: [{ type: "function" }],
    }),
  },
]) {
  test(
    "mismatched final request or clamped effort refuses before reservation " +
      JSON.stringify(change),
    async ({ onTestFinished }) => {
      const { store, r, capture } = setup(onTestFinished);
      capture.candidate("openai-codex", "gpt-6.1-sol", "high");
      capture.runnerStarted();
      await assert.rejects(() => capture.observer.onRequest({ ...request, ...change }));
      assert.equal(store.read(r.operationId).record.attempts.length, 0);
    },
  );
}
test("malformed non-array tools payload refuses before reservation", async ({ onTestFinished }) => {
  const { store, r, capture } = setup(onTestFinished);
  capture.candidate("openai-codex", "gpt-6.1-sol", "high");
  capture.runnerStarted();
  const body = JSON.stringify({
    ...JSON.parse(request.body),
    tools: { type: "function", name: "unexpected" },
  });
  await assert.rejects(() => capture.observer.onRequest({ ...request, body }));
  assert.equal(store.read(r.operationId).record.attempts.length, 0);
});
const nonTextInputs: Array<[string, unknown[]]> = [
  [
    "object content",
    [{ role: "user", content: { type: "input_image", image_url: "data:image/png;base64,AA==" } }],
  ],
  ["top-level image", [{ type: "input_image", image_url: "data:image/png;base64,AA==" }]],
  ["tool role", [{ role: "tool", content: "unbound tool output" }]],
  [
    "nested image",
    [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  ],
];
for (const [label, input] of nonTextInputs) {
  test(`non-text wire input (${label}) refuses before reservation`, async ({ onTestFinished }) => {
    const { store, r, capture } = setup(onTestFinished);
    capture.candidate("openai-codex", "gpt-6.1-sol", "high");
    capture.runnerStarted();
    const body = JSON.stringify({ ...JSON.parse(request.body), input });
    await assert.rejects(() => capture.observer.onRequest({ ...request, body }));
    assert.equal(store.read(r.operationId).record.attempts.length, 0);
  });
}
test("text history and provider reasoning signatures remain eligible", async ({
  onTestFinished,
}) => {
  const { store, r, capture } = setup(onTestFinished);
  capture.candidate("openai-codex", "gpt-6.1-sol", "high");
  capture.runnerStarted();
  const body = JSON.stringify({
    ...JSON.parse(request.body),
    input: [
      { role: "developer", content: "bound system prompt" },
      { type: "reasoning", id: "rs_prior", encrypted_content: "opaque", summary: [] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "prior assistant text" }],
      },
      { role: "user", content: "bound current facts" },
    ],
  });
  await capture.observer.onRequest({ ...request, body });
  const saved = store.read(r.operationId).record;
  assert.equal(saved.attempts.length, 1);
  assert.equal(store.readBlob(saved.attempts[0].requestBody).toString(), body);
});
test("request without input refuses before reservation", async ({ onTestFinished }) => {
  const { store, r, capture } = setup(onTestFinished);
  capture.candidate("openai-codex", "gpt-6.1-sol", "high");
  capture.runnerStarted();
  const body = JSON.stringify({
    model: "gpt-6.1-sol",
    reasoning: { effort: "high" },
    stream: true,
  });
  await assert.rejects(() => capture.observer.onRequest({ ...request, body }));
  assert.equal(store.read(r.operationId).record.attempts.length, 0);
});
test("independent original terminal projection preserves exact text and absent effort", () => {
  const p = projectLegalTerminal(frame(), {
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    effort: "high",
    physicalRequestCeiling: 1,
  });
  assert.equal(p.text, text);
  assert.equal(p.observedEffort, null);
});
for (const change of [
  { id: "" },
  { model: "gpt-6-astra" },
  { status: "incomplete" },
  { error: { message: "x" } },
  { incomplete_details: {} },
  { reasoning: { effort: "medium" } },
  { output: [] },
  { output: [{ type: "function_call" }] },
  {
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: "x" }],
      },
    ],
  },
]) {
  test("terminal facts refuse " + JSON.stringify(change), () =>
    assert.throws(() =>
      projectLegalTerminal(frame(change), {
        provider: "openai-codex",
        model: "gpt-6.1-sol",
        effort: "high",
        physicalRequestCeiling: 1,
      }),
    ),
  );
}
test("full capture seals only after exact assembly and real clean runner summary", async ({
  onTestFinished,
}) => {
  const { store, r, capture } = setup(onTestFinished);
  capture.candidate("openai-codex", "gpt-6.1-sol", "high");
  capture.runnerStarted();
  await capture.observer.onRequest(request);
  await capture.observer.onResponse({ status: 200, contentType: "text/event-stream" });
  await capture.observer.onChunk(frame());
  await capture.observer.onTerminal(frame());
  await capture.observer.onComplete({ text, stopReason: "stop", toolCalls: 0 });
  assert.equal(store.read(r.operationId).record.state, "running");
  capture.finishRunner(clean);
  const saved = store.read(r.operationId).record;
  assert.equal(saved.state, "completed");
  assert.equal(store.readBlob(saved.attempts[0].assembledText!).toString(), text);
  assert.equal(saved.attempts[0].terminal!.observedEffort, null);
});
test("mutated, trimmed or missing assembled text cannot seal", async ({ onTestFinished }) => {
  for (const assembly of [text + "\n", text.trim() + " ", ""]) {
    const { store, r, capture } = setup(onTestFinished);
    capture.candidate("openai-codex", "gpt-6.1-sol", "high");
    capture.runnerStarted();
    await capture.observer.onRequest(request);
    await capture.observer.onResponse({ status: 200, contentType: "text/event-stream" });
    await capture.observer.onChunk(frame());
    await capture.observer.onTerminal(frame());
    await assert.rejects(() =>
      capture.observer.onComplete({ text: assembly, stopReason: "stop", toolCalls: 0 }),
    );
    assert.notEqual(store.read(r.operationId).record.state, "completed");
  }
});
test("simultaneous contexts keep operation bytes and budgets isolated", async ({
  onTestFinished,
}) => {
  const a = setup(onTestFinished),
    b = setup(onTestFinished);
  for (const c of [a.capture, b.capture]) {
    c.candidate("openai-codex", "gpt-6.1-sol", "high");
    c.runnerStarted();
  }
  await Promise.all([
    a.capture.observer.onRequest(request),
    b.capture.observer.onRequest({ ...request, body: request.body.replace("offline", "other") }),
  ]);
  assert.notEqual(
    a.store.read(a.r.operationId).record.attempts[0].requestBody.sha256,
    b.store.read(b.r.operationId).record.attempts[0].requestBody.sha256,
  );
});
test("storage failure never permits a retry", async ({ onTestFinished }) => {
  const { capture, store, r } = setup(onTestFinished);
  capture.candidate("openai-codex", "gpt-6.1-sol", "high");
  capture.runnerStarted();
  await capture.observer.onRequest(request);
  const commit = store.commit.bind(store);
  store.commit = () => {
    throw Error("disk");
  };
  await assert.rejects(() =>
    capture.observer.onResponse({ status: 200, contentType: "text/event-stream" }),
  );
  store.commit = commit;
  await assert.rejects(() => capture.observer.onRequest(request));
  assert.equal(store.read(r.operationId).record.attempts.length, 1);
});
test("runner summaries refuse all forbidden effects", async ({ onTestFinished }) => {
  for (const key of Object.keys(clean) as (keyof ExecutionSummary)[]) {
    const { capture } = setup(onTestFinished);
    assert.throws(() => capture.finishRunner({ ...clean, [key]: key === "aborted" ? true : 1 }));
  }
});
