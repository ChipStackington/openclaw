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
import { bytesHash, evidenceHash } from "./hash.js";
import { EngineEvidenceStore } from "./store.js";
import type { EngineReceipt, ExecutionSummary, RuntimeIdentity } from "./types.js";
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
function frame(change: Record<string, unknown> = {}, outputText = text) {
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
              content: [{ type: "output_text", text: outputText }],
            },
          ],
          ...change,
        },
      }) +
      "\r\n\r\n",
  );
}
function prepared(store: EngineEvidenceStore, submittedAssignment = "offline"): EngineReceipt {
  const r = structuredClone(fixtures.records.engine.record) as EngineReceipt;
  r.operationId = randomUUID();
  r.binding.operationId = r.operationId;
  r.preparedAt = new Date().toISOString();
  r.binding.deadlineAt = new Date(Date.now() + 60_000).toISOString();
  r.binding.submittedPromptHash = bytesHash(submittedAssignment);
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
function setup(onFinished: (fn: () => void) => void, submittedAssignment = "offline") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legal-b2-"));
  onFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new EngineEvidenceStore(root),
    r = prepared(store, submittedAssignment);
  return {
    store,
    r,
    capture: LegalEvidenceCapture.create(store, r, submittedAssignment, () =>
      structuredClone(r.runtime),
    ),
  };
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
  assert.throws(() =>
    LegalEvidenceCapture.create(store, r, "offline", () => structuredClone(r.runtime)),
  );
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
      {
        role: "user",
        content: [
          { type: "input_text", text: "off" },
          { type: "input_text", text: "line" },
        ],
      },
    ],
  });
  await capture.observer.onRequest({ ...request, body });
  const saved = store.read(r.operationId).record;
  assert.equal(saved.attempts.length, 1);
  assert.equal(store.readBlob(saved.attempts[0].requestBody).toString(), body);
});
for (const [label, input] of [
  ["changed assignment", [{ role: "user", content: "different assignment" }]],
  [
    "extra user turn",
    [
      { role: "user", content: "offline" },
      { role: "user", content: "unbound prior turn" },
    ],
  ],
  ["missing assignment", [{ role: "assistant", content: "offline" }]],
] as Array<[string, unknown[]]>) {
  test(`wire request must retain the sole complete submitted assignment (${label})`, async ({
    onTestFinished,
  }) => {
    const { store, r, capture } = setup(onTestFinished);
    capture.candidate("openai-codex", "gpt-6.1-sol", "high");
    capture.runnerStarted();
    const body = JSON.stringify({ ...JSON.parse(request.body), input });
    await assert.rejects(() => capture.observer.onRequest({ ...request, body }));
    assert.equal(store.read(r.operationId).record.attempts.length, 0);
  });
}
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
test("capture creation binds assignment bytes to the ingress prompt hash", async ({
  onTestFinished,
}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legal-b2-assignment-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new EngineEvidenceStore(root),
    r = prepared(store);
  assert.throws(() =>
    LegalEvidenceCapture.create(store, r, "changed assignment", () => structuredClone(r.runtime)),
  );
  assert.equal(fs.existsSync(path.join(root, "operations", `${r.operationId}.json`)), false);
  const overLimit = "x".repeat(1_000_001),
    oversized = prepared(store, overLimit);
  assert.throws(() =>
    LegalEvidenceCapture.create(store, oversized, overLimit, () =>
      structuredClone(oversized.runtime),
    ),
  );
  assert.equal(
    fs.existsSync(path.join(root, "operations", `${oversized.operationId}.json`)),
    false,
  );
});
test("capture creation rejects a submitted assignment that cannot round-trip as UTF-8", async ({
  onTestFinished,
}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legal-b2-invalid-assignment-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new EngineEvidenceStore(root);
  for (const assignment of ["high-\uD800", "low-\uDC00"]) {
    const r = prepared(store, assignment);
    assert.throws(() =>
      LegalEvidenceCapture.create(store, r, assignment, () => structuredClone(r.runtime)),
    );
    assert.equal(fs.existsSync(path.join(root, "operations", `${r.operationId}.json`)), false);
  }
});
test("terminal projection preserves bounded output above the metadata JSON limit", () => {
  const output = "x".repeat(900_000),
    projected = projectLegalTerminal(frame({}, output), {
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      effort: "high",
      physicalRequestCeiling: 1,
    });
  assert.equal(projected.text, output);
});
test("terminal projection rejects lone surrogate output but keeps valid surrogate pairs", () => {
  for (const output of ["high-\uD800", "low-\uDC00"]) {
    assert.throws(() =>
      projectLegalTerminal(frame({}, output), {
        provider: "openai-codex",
        model: "gpt-6.1-sol",
        effort: "high",
        physicalRequestCeiling: 1,
      }),
    );
  }
  const validPair = "pair-\uD83D\uDE80";
  assert.equal(
    projectLegalTerminal(frame({}, validPair), {
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      effort: "high",
      physicalRequestCeiling: 1,
    }).text,
    validPair,
  );
});
test("wire capture accepts the approved request bound above the metadata JSON limit", async ({
  onTestFinished,
}) => {
  const assignment = "a".repeat(150_000),
    { store, r, capture } = setup(onTestFinished, assignment);
  capture.candidate("openai-codex", "gpt-6.1-sol", "high");
  capture.runnerStarted();
  const body = JSON.stringify({
    model: "gpt-6.1-sol",
    reasoning: { effort: "high" },
    stream: true,
    input: [{ role: "user", content: assignment }],
  });
  await capture.observer.onRequest({ ...request, body });
  const saved = store.read(r.operationId).record;
  assert.equal(saved.attempts.length, 1);
  assert.equal(store.readBlob(saved.attempts[0].requestBody).toString(), body);
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
    b = setup(onTestFinished, "other");
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

// Real byte changes in disposable development material must be observed at use.
for (const boundary of ["send", "seal"] as const) {
  test(`current runtime material drift refuses at ${boundary}`, async ({ onTestFinished }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "legal-astra-material-"));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const materialFile = path.join(root, "DEVELOPMENT-adapter.js");
    fs.writeFileSync(materialFile, "development adapter original");
    const store = new EngineEvidenceStore(path.join(root, "evidence"));
    const r = prepared(store);
    r.runtime.adapterContentHash = bytesHash(fs.readFileSync(materialFile));
    r.binding.engineAdapterContentHash = r.runtime.adapterContentHash;
    r.bindingHash = evidenceHash(r.binding);
    const readRuntime = (): RuntimeIdentity => ({
      ...r.runtime,
      adapterContentHash: bytesHash(fs.readFileSync(materialFile)),
    });
    const capture = LegalEvidenceCapture.create(store, r, "offline", readRuntime);
    capture.candidate("openai-codex", "gpt-6.1-sol", "high");
    capture.runnerStarted();
    if (boundary === "send") {
      fs.writeFileSync(materialFile, "development adapter changed");
      await assert.rejects(() => capture.observer.onRequest(request));
      assert.equal(store.read(r.operationId).record.attempts.length, 0);
    } else {
      await capture.observer.onRequest(request);
      await capture.observer.onResponse({ status: 200, contentType: "text/event-stream" });
      await capture.observer.onChunk(frame());
      await capture.observer.onTerminal(frame());
      await capture.observer.onComplete({ text, stopReason: "stop", toolCalls: 0 });
      fs.writeFileSync(materialFile, "development adapter changed");
      assert.throws(() => capture.finishRunner(clean));
      assert.notEqual(store.read(r.operationId).record.state, "completed");
    }
  });
}
