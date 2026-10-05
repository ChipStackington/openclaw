import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import fixtures from "./development-fixtures.json" with { type: "json" };
import {
  getLegalEvidenceCapabilities,
  getLegalEvidenceOperation,
  readLegalEvidenceBlob,
  resolveEvidenceClientBinding,
  reserveLegalEvidenceIngress,
  validateLegalEvidenceIngress,
} from "./gateway.js";
import { bytesHash, evidenceHash } from "./hash.js";
import { LEGAL_EVIDENCE_MODEL_POLICY_HASH } from "./policy.js";
import { EngineEvidenceStore } from "./store.js";
import type { CaptureRequest, RuntimeIdentity } from "./types.js";

const prompt = "Analyze the admitted matter packet under the assigned legal role.";
const now = new Date("2026-10-04T12:00:00.000Z");
const runtime = structuredClone(fixtures.records.engine.record.runtime) as RuntimeIdentity;
const modelPolicyHash = LEGAL_EVIDENCE_MODEL_POLICY_HASH;

function onDisk(onFinished: (f: () => void) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quinn-engine-b3-"));
  onFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function ingress() {
  const descriptor = structuredClone(fixtures.records.capture) as CaptureRequest;
  descriptor.binding.operationId = "00000000-0000-4000-8000-000000000011";
  descriptor.binding.runId = "00000000-0000-4000-8000-000000000012";
  descriptor.binding.sessionKey = "agent:legal-facts:legal:00000000-0000-4000-8000-000000000011";
  descriptor.binding.roleId = "legal-facts";
  descriptor.binding.submittedPromptHash = bytesHash(prompt);
  descriptor.binding.modelPolicyHash = modelPolicyHash;
  descriptor.binding.engineInstallationId = runtime.installationId;
  descriptor.binding.engineRevision = runtime.engineRevision;
  descriptor.binding.engineBuildHash = runtime.engineBuildHash;
  descriptor.binding.engineAdapterVersion = runtime.adapterVersion;
  descriptor.binding.engineAdapterPatchHash = runtime.adapterPatchHash;
  descriptor.binding.engineAdapterContentHash = runtime.adapterContentHash;
  descriptor.binding.engineRolePolicyHash = runtime.rolePolicyHash;
  descriptor.binding.deadlineAt = new Date(now.getTime() + 60_000).toISOString();
  descriptor.bindingHash = evidenceHash(descriptor.binding);
  const params = {
    message: prompt,
    agentId: descriptor.binding.roleId,
    sessionKey: descriptor.binding.sessionKey,
    thinking: descriptor.binding.expected.effort,
    deliver: false,
    idempotencyKey: descriptor.binding.operationId,
    legalEvidence: descriptor,
  };
  const peer = {
    authenticatedDeviceId: "verified-device-1",
    clientId: "mission-control-cli",
    clientRole: "operator",
    clientMode: "cli",
    scopes: ["operator.read", "operator.write"],
    isWebchat: false,
  };
  return { descriptor, params, peer };
}

test("MC run identity remains distinct from the gateway idempotency operation identity", () => {
  const f = ingress();
  assert.notEqual(f.descriptor.binding.operationId, f.descriptor.binding.runId);
  f.params.idempotencyKey = f.descriptor.binding.operationId;
  assert.doesNotThrow(() => validateLegalEvidenceIngress({ ...f, runtime, now }));
  f.params.idempotencyKey = f.descriptor.binding.runId;
  assert.throws(() => validateLegalEvidenceIngress({ ...f, runtime, now }));
});

test("gateway refuses a supported model/effort assigned to the wrong legal role", () => {
  const f = ingress();
  f.descriptor.binding.expected.model = "gpt-6-astra";
  f.descriptor.binding.expected.effort = "medium";
  f.params.thinking = "medium";
  f.descriptor.bindingHash = evidenceHash(f.descriptor.binding);
  assert.throws(() => validateLegalEvidenceIngress({ ...f, runtime, now }));
});

test("the old partial model-list policy hash cannot authorize the complete strict policy", () => {
  const f = ingress();
  f.descriptor.binding.modelPolicyHash = evidenceHash({
    version: "quinn-legal-single-request-v1",
    providers: ["openai-codex"],
    models: ["gpt-6.1-sol", "gpt-6-astra"],
    efforts: ["high", "medium"],
    physicalRequestCeiling: 1,
    transport: "sse",
  });
  f.descriptor.bindingHash = evidenceHash(f.descriptor.binding);
  assert.throws(() => validateLegalEvidenceIngress({ ...f, runtime, now }));
});

test("evidence ingress requires an authenticated CLI device and the required operator scope", () => {
  const { peer } = ingress();
  assert.equal(resolveEvidenceClientBinding(peer, "operator.write").deviceId, "verified-device-1");
  for (const change of [
    { authenticatedDeviceId: undefined },
    { clientMode: "webchat" },
    { isWebchat: true },
    { scopes: ["operator.read"] },
  ]) {
    assert.throws(() => resolveEvidenceClientBinding({ ...peer, ...change }, "operator.write"));
  }
});

test("prepared ingress is durably reserved before it can be acknowledged", ({ onTestFinished }) => {
  const { descriptor, params, peer } = ingress();
  const store = new EngineEvidenceStore(onDisk(onTestFinished));
  const result = reserveLegalEvidenceIngress({ store, descriptor, params, peer, runtime, now });
  assert.equal(result.created, true);
  assert.equal(result.envelope.record.state, "prepared");
  assert.equal(result.envelope.record.attempts.length, 0);
  assert.equal(store.read(descriptor.binding.operationId).hash, result.envelope.hash);
});

test("same-process duplicate stays prepared; a stranded reservation becomes unknown after restart", ({
  onTestFinished,
}) => {
  const { descriptor, params, peer } = ingress();
  const root = onDisk(onTestFinished);
  const activeOperationIds = new Set([descriptor.binding.operationId]);
  const first = reserveLegalEvidenceIngress({
    store: new EngineEvidenceStore(root),
    descriptor,
    params,
    peer,
    runtime,
    now,
    activeOperationIds,
  });
  const duplicate = reserveLegalEvidenceIngress({
    store: new EngineEvidenceStore(root),
    descriptor,
    params,
    peer,
    runtime,
    now: new Date(now.getTime() + 5_000),
    activeOperationIds,
  });
  const recovered = reserveLegalEvidenceIngress({
    store: new EngineEvidenceStore(root),
    descriptor,
    params,
    peer,
    runtime,
    now: new Date(now.getTime() + 10_000),
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.envelope.record.state, "prepared");
  assert.equal(recovered.created, false);
  assert.equal(recovered.envelope.record.state, "unknown");
  assert.equal(recovered.envelope.record.attempts.length, 0);
  assert.equal(
    new EngineEvidenceStore(root).read(descriptor.binding.operationId).record.state,
    "unknown",
  );
});

test("reading a stranded prepared operation after restart persists unknown without scheduling", ({
  onTestFinished,
}) => {
  const { descriptor, params, peer } = ingress();
  const root = onDisk(onTestFinished);
  const store = new EngineEvidenceStore(root);
  const prepared = reserveLegalEvidenceIngress({ store, descriptor, params, peer, runtime, now });
  const recovered = getLegalEvidenceOperation({
    store: new EngineEvidenceStore(root),
    operationId: descriptor.binding.operationId,
    peer,
    activeOperationIds: new Set(),
  });
  assert.equal(recovered.state, "unknown");
  assert.equal(recovered.envelope?.record.attempts.length, 0);
  assert.equal(store.read(descriptor.binding.operationId).record.state, "unknown");
  assert.equal(prepared.created, true);
});

test("an unknown durable operation remains unknown and is never re-reserved", ({
  onTestFinished,
}) => {
  const { descriptor, params, peer } = ingress();
  const root = onDisk(onTestFinished);
  const store = new EngineEvidenceStore(root);
  const first = reserveLegalEvidenceIngress({ store, descriptor, params, peer, runtime, now });
  const unknown = structuredClone(first.envelope.record);
  unknown.state = "unknown";
  unknown.holdReason = "transport-unknown";
  unknown.endedAt = new Date(now.getTime() + 1_000).toISOString();
  store.commit(unknown, first.envelope.hash);

  const recovered = reserveLegalEvidenceIngress({
    store: new EngineEvidenceStore(root),
    descriptor,
    params,
    peer,
    runtime,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(recovered.created, false);
  assert.equal(recovered.envelope.record.state, "unknown");
  assert.equal(recovered.envelope.record.attempts.length, 0);
});

test("operation UUID cannot be reused with another binding or authenticated device", ({
  onTestFinished,
}) => {
  const { descriptor, params, peer } = ingress();
  const root = onDisk(onTestFinished);
  const store = new EngineEvidenceStore(root);
  reserveLegalEvidenceIngress({ store, descriptor, params, peer, runtime, now });

  const changed = structuredClone(descriptor);
  changed.binding.taskId = "different-task";
  changed.bindingHash = evidenceHash(changed.binding);
  assert.throws(() =>
    reserveLegalEvidenceIngress({ store, descriptor: changed, params, peer, runtime, now }),
  );
  assert.throws(() =>
    reserveLegalEvidenceIngress({
      store,
      descriptor,
      params,
      peer: { ...peer, authenticatedDeviceId: "other-verified-device" },
      runtime,
      now,
    }),
  );
});

test("changed message, session, run, delivery, model policy or extra override refuses before reserve", ({
  onTestFinished,
}) => {
  const { descriptor, params, peer } = ingress();
  const root = onDisk(onTestFinished);
  for (const [index, change] of [
    { message: "different prompt" },
    { sessionKey: "agent:legal-facts:other" },
    { idempotencyKey: "00000000-0000-4000-8000-000000000099" },
    { deliver: true },
    { channel: "webchat" },
    { attachments: [] },
    { workspaceDir: "C:/foreign" },
    { internalEvents: [] },
  ].entries()) {
    const store = new EngineEvidenceStore(path.join(root, `case-${index}`));
    assert.throws(() =>
      reserveLegalEvidenceIngress({
        store,
        descriptor,
        params: { ...params, ...change },
        peer,
        runtime,
        now,
      }),
    );
    assert.equal(
      fs.existsSync(path.join(store.root, "operations", descriptor.binding.operationId + ".json")),
      false,
    );
  }
  const extraDescriptor = {
    ...descriptor,
    hidden: "unapproved-key",
  } as CaptureRequest;
  assert.throws(() =>
    reserveLegalEvidenceIngress({
      store: new EngineEvidenceStore(path.join(root, "extra-descriptor")),
      descriptor: extraDescriptor,
      params: { ...params, legalEvidence: extraDescriptor },
      peer,
      runtime,
      now,
    }),
  );
  const policy = structuredClone(descriptor);
  policy.modelPolicy = "unsupported" as CaptureRequest["modelPolicy"];
  assert.throws(() =>
    reserveLegalEvidenceIngress({
      store: new EngineEvidenceStore(root + "-policy"),
      descriptor: policy,
      params: { ...params, legalEvidence: policy },
      peer,
      runtime,
      now,
    }),
  );
  const invalidRuntime = { ...runtime, adapterPatchHash: "f".repeat(64) };
  assert.throws(() =>
    reserveLegalEvidenceIngress({
      store: new EngineEvidenceStore(root + "-runtime"),
      descriptor,
      params,
      peer,
      runtime: invalidRuntime,
      now,
    }),
  );
});

test("evidence reads require operator.read and only expose operation-manifest blobs in bounded chunks", ({
  onTestFinished,
}) => {
  const { descriptor, params, peer } = ingress();
  const store = new EngineEvidenceStore(onDisk(onTestFinished));
  const prepared = reserveLegalEvidenceIngress({ store, descriptor, params, peer, runtime, now });
  const journal = prepared.envelope.record.journal;
  const chunk = readLegalEvidenceBlob({
    store,
    operationId: descriptor.binding.operationId,
    blobHash: journal.sha256,
    offset: 0,
    length: journal.bytes,
    peer,
  });
  assert.equal(Buffer.from(chunk.dataBase64, "base64").toString(), "[]");
  assert.throws(() =>
    readLegalEvidenceBlob({
      store,
      operationId: descriptor.binding.operationId,
      blobHash: "../outside",
      offset: 0,
      length: 1,
      peer,
    }),
  );
  const orphan = store.putBlob("submitted-prompt", Buffer.from(prompt));
  assert.throws(() =>
    readLegalEvidenceBlob({
      store,
      operationId: descriptor.binding.operationId,
      blobHash: orphan.sha256,
      offset: 0,
      length: 1,
      peer,
    }),
  );
  for (const change of [
    { offset: -1, length: 1 },
    { offset: 0, length: 128_001 },
    { offset: 0, length: journal.bytes + 1 },
    { offset: 1, length: journal.bytes },
  ]) {
    assert.throws(() =>
      readLegalEvidenceBlob({
        store,
        operationId: descriptor.binding.operationId,
        blobHash: journal.sha256,
        ...change,
        peer,
      }),
    );
  }
  assert.throws(() =>
    readLegalEvidenceBlob({
      store,
      operationId: descriptor.binding.operationId,
      blobHash: journal.sha256,
      offset: 0,
      length: journal.bytes,
      peer: { ...peer, scopes: ["operator.write"] },
    }),
  );
  assert.throws(() =>
    readLegalEvidenceBlob({
      store,
      operationId: descriptor.binding.operationId,
      blobHash: journal.sha256,
      offset: 0,
      length: journal.bytes,
      peer: { ...peer, authenticatedDeviceId: "foreign-device" },
    }),
  );
});

test("missing measured runtime makes capabilities unavailable instead of inventing pins", () => {
  assert.equal(getLegalEvidenceCapabilities(undefined), undefined);
  const capabilities = getLegalEvidenceCapabilities(() => structuredClone(runtime));
  assert.equal(capabilities?.available, true);
  assert.deepEqual(capabilities?.runtime, runtime);
});
