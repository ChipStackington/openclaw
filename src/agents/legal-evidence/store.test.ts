import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import fixtures from "./development-fixtures.json" with { type: "json" };
import { bytesHash, evidenceHash, evidenceJsonV1 } from "./hash.js";
import { EngineEvidenceStore } from "./store.js";
import type { Blob, EngineReceipt, WireAttempt } from "./types.js";

function fixture(onFinished: (f: () => void) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quinn-engine-b1-"));
  onFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new EngineEvidenceStore(root),
    record = structuredClone(fixtures.records.engine.record) as EngineReceipt;
  record.state = "prepared";
  record.events = [];
  record.attempts = [];
  record.journal = store.putBlob("journal", Buffer.from("[]"));
  for (const key of ["endedAt", "selectedAttemptId", "executionSummary", "holdReason"] as const) {
    delete record[key];
  }
  return { root, store, record };
}
function sendIntent(store: EngineEvidenceStore, record: EngineReceipt): EngineReceipt {
  const next = structuredClone(record);
  next.state = "running";
  const attempt = structuredClone(fixtures.records.engine.record.attempts[0]) as WireAttempt;
  for (const key of [
    "responseObservedAt",
    "httpStatus",
    "responseStream",
    "terminal",
    "projectionPolicy",
    "providerText",
    "assembledText",
    "adapterStopReason",
    "usage",
  ] as const) {
    delete attempt[key];
  }
  attempt.state = "send-intent";
  attempt.requestBody = store.putBlob("request-body", Buffer.from('{"model":"gpt-6.1-sol"}'));
  next.attempts = [attempt];
  return next;
}
for (const kind of [
  "packet",
  "submitted-prompt",
  "request-body",
  "provider-text",
  "assembled-text",
  "journal",
] as const) {
  test(`${kind} refuses malformed UTF-8 before writing and on direct persisted reads`, ({
    onTestFinished,
  }) => {
    const { root, store } = fixture(onTestFinished);
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from([0xe2, 0x82]),
      Buffer.from([0xed, 0xa0, 0x80]),
    ]) {
      assert.throws(() => store.putBlob(kind, bytes));
      const blob: Blob = { kind, sha256: bytesHash(bytes), bytes: bytes.length, encoding: "utf8" };
      assert.equal(fs.existsSync(path.join(root, "blobs", blob.sha256)), false);
      fs.writeFileSync(path.join(root, "blobs", blob.sha256), bytes);
      assert.throws(() => new EngineEvidenceStore(root).readBlob(blob));
      fs.unlinkSync(path.join(root, "blobs", blob.sha256));
    }
    const valid = Buffer.from("\uFEFFlegal \u00E9 \uD83D\uDE80");
    assert.deepEqual(store.readBlob(store.putBlob(kind, valid)), valid);
  });
}
test("binary response stream and terminal frame preserve malformed text bytes exactly", ({
  onTestFinished,
}) => {
  const { store } = fixture(onTestFinished),
    bytes = Buffer.from([0xff, 0xc0, 0xaf, 0xe2, 0x82]);
  for (const kind of ["response-stream", "terminal-frame"] as const) {
    assert.deepEqual(store.readBlob(store.putBlob(kind, bytes)), bytes);
  }
});
test("permanent reservation is durable; identical UUID never schedules again after restart", ({
  onTestFinished,
}) => {
  const { root, store, record } = fixture(onTestFinished);
  assert.equal(store.reserve(record).created, true);
  assert.equal(new EngineEvidenceStore(root).reserve(record).created, false);
  assert.deepEqual(new EngineEvidenceStore(root).read(record.operationId).record, record);
});
for (const field of ["binding", "client", "runtime", "captureOrigin"] as const) {
  test(`reserved operation rejects changed ${field} without overwriting`, ({ onTestFinished }) => {
    const { store, record } = fixture(onTestFinished);
    const saved = store.reserve(record).envelope;
    const changed = structuredClone(record);
    if (field === "captureOrigin") {
      changed.captureOrigin = "runtime";
    }
    if (field === "binding") {
      changed.binding.scope.tenantId = "foreign";
      changed.bindingHash = evidenceHash(changed.binding);
    }
    if (field === "client") {
      changed.client.deviceId = "foreign";
    }
    if (field === "runtime") {
      changed.runtime.adapterPatchHash = "f".repeat(64);
    }
    assert.throws(() => store.reserve(changed));
    assert.deepEqual(store.read(record.operationId), saved);
  });
}
test("checked engine reader refuses tampered record, hard link, traversal and junction", ({
  onTestFinished,
}) => {
  const { root, store, record } = fixture(onTestFinished);
  store.reserve(record);
  const file = path.join(root, "operations", record.operationId + ".json");
  fs.linkSync(file, path.join(root, "extra-link"));
  assert.throws(() => store.read(record.operationId));
  fs.unlinkSync(path.join(root, "extra-link"));
  fs.writeFileSync(file, JSON.stringify({ record, hash: "f".repeat(64) }));
  assert.throws(() => store.read(record.operationId));
  assert.throws(() => store.read("../outside"));
  fs.symlinkSync(root, path.join(root, "alias"), "junction");
  assert.throws(() => new EngineEvidenceStore(path.join(root, "alias")));
});
test("physical reservation cannot be reset, replaced or increased after durable send intent", ({
  onTestFinished,
}) => {
  const { store, record } = fixture(onTestFinished),
    initial = store.reserve(record).envelope;
  const running = sendIntent(store, record),
    saved = store.commit(running, initial.hash);
  assert.throws(() => store.commit({ ...running, attempts: [] }, saved.hash));
  const changed = structuredClone(running);
  changed.attempts[0].id = "00000000-0000-4000-8000-000000000099";
  assert.throws(() => store.commit(changed, saved.hash));
  assert.throws(() =>
    store.commit({ ...running, attempts: [running.attempts[0], running.attempts[0]] }, saved.hash),
  );
  assert.throws(() => store.commit(record, saved.hash));
  assert.deepEqual(store.read(record.operationId), saved);
});
test("stale commit and leftover engine lock hold without mutation", ({ onTestFinished }) => {
  const { root, store, record } = fixture(onTestFinished),
    initial = store.reserve(record).envelope;
  const running = sendIntent(store, record);
  store.commit(running, initial.hash);
  assert.throws(() => store.commit({ ...running, state: "unknown" }, initial.hash));
  fs.mkdirSync(path.join(root, "locks"), { recursive: true });
  fs.writeFileSync(path.join(root, "locks", record.operationId + ".lock"), "leftover");
  assert.throws(() =>
    store.commit({ ...running, state: "unknown" }, store.read(record.operationId).hash),
  );
});
test("journal/event sequence, runtime pins and blob metadata are verified relationally", ({
  onTestFinished,
}) => {
  const { store, record } = fixture(onTestFinished);
  const changed = structuredClone(record);
  changed.events = [{ seq: 2, at: record.preparedAt, kind: "runner-started" }];
  changed.journal = store.putBlob("journal", Buffer.from(evidenceJsonV1(changed.events)));
  assert.throws(() => store.reserve(changed));
  assert.throws(() => store.reserve({ ...record, bindingHash: "f".repeat(64) }));
  assert.throws(() =>
    store.reserve({
      ...record,
      runtime: { ...record.runtime, adapterContentHash: "f".repeat(64) },
    }),
  );
  assert.throws(() => store.readBlob({ ...record.journal, bytes: 123 }));
});
test("missing captured material never makes an existing UUID available for another dispatch", ({
  onTestFinished,
}) => {
  const { root, store, record } = fixture(onTestFinished),
    reserved = store.reserve(record).envelope;
  const running = sendIntent(store, record);
  store.commit(running, reserved.hash);
  fs.unlinkSync(path.join(root, "blobs", running.attempts[0].requestBody.sha256));
  const file = path.join(root, "operations", record.operationId + ".json"),
    bytes = fs.readFileSync(file);
  assert.throws(() => store.reserve(record));
  assert.deepEqual(fs.readFileSync(file), bytes);
});
