import { bytesHash, evidenceHash } from "./hash.js";
import { assertLegalEvidencePolicy } from "./policy.js";
import {
  readCurrentLegalEvidenceRuntime,
  readCurrentLegalEvidenceRuntimeAsync,
} from "./runtime.js";
import { assertEvidenceSchema } from "./schema.js";
import { EngineEvidenceStore } from "./store.js";
import type {
  CaptureRequest,
  Capabilities,
  ClientBinding,
  EngineEnvelope,
  EngineReceipt,
  EvidenceReadResult,
  RuntimeIdentity,
} from "./types.js";

export { LEGAL_EVIDENCE_MODEL_POLICY_HASH } from "./policy.js";

export type EvidencePeer = {
  authenticatedDeviceId?: string | null;
  clientId: string;
  clientRole: string;
  clientMode: string;
  scopes: readonly string[];
  isWebchat?: boolean;
};

export type EvidenceIngressParams = {
  message: string;
  agentId?: string;
  sessionKey?: string;
  thinking?: string;
  deliver?: boolean;
  idempotencyKey: string;
  legalEvidence?: unknown;
  [key: string]: unknown;
};

const ingressKeys = new Set([
  "message",
  "agentId",
  "sessionKey",
  "thinking",
  "deliver",
  "idempotencyKey",
  "legalEvidence",
]);

export function resolveEvidenceClientBinding(
  peer: EvidencePeer,
  requiredScope: "operator.read" | "operator.write",
): ClientBinding {
  const deviceId = peer.authenticatedDeviceId;
  if (
    !deviceId ||
    deviceId.length > 200 ||
    peer.clientRole !== "operator" ||
    peer.clientMode !== "cli" ||
    peer.isWebchat ||
    !peer.scopes.includes(requiredScope)
  ) {
    throw new Error("legal-evidence-client-denied");
  }
  const binding: ClientBinding = {
    deviceId,
    clientRole: "operator",
    clientMode: "cli",
    deviceBindingHash: evidenceHash({
      deviceId,
      clientId: peer.clientId,
      clientRole: peer.clientRole,
      clientMode: peer.clientMode,
    }),
  };
  assertEvidenceSchema("ClientBinding", binding);
  return binding;
}

function assertRuntimeMatches(runtime: RuntimeIdentity, request: CaptureRequest): void {
  assertEvidenceSchema("RuntimeIdentity", runtime);
  const binding = request.binding;
  assertLegalEvidencePolicy(binding);
  if (
    request.modelPolicy !== "quinn-legal-single-request-v1" ||
    runtime.installationId !== binding.engineInstallationId ||
    runtime.engineRevision !== binding.engineRevision ||
    runtime.engineBuildHash !== binding.engineBuildHash ||
    runtime.adapterVersion !== binding.engineAdapterVersion ||
    runtime.adapterPatchHash !== binding.engineAdapterPatchHash ||
    runtime.adapterContentHash !== binding.engineAdapterContentHash ||
    runtime.rolePolicyHash !== binding.engineRolePolicyHash
  ) {
    throw new Error("legal-evidence-runtime-mismatch");
  }
}

function assertIngressMatches(
  descriptor: CaptureRequest,
  params: EvidenceIngressParams,
  runtime: RuntimeIdentity,
  now: Date,
): void {
  assertEvidenceSchema("CaptureRequest", descriptor);
  if (Object.keys(params).some((key) => !ingressKeys.has(key))) {
    throw new Error("legal-evidence-ingress-override");
  }
  const binding = descriptor.binding;
  if (
    params.legalEvidence === undefined ||
    evidenceHash(params.legalEvidence) !== evidenceHash(descriptor) ||
    params.deliver !== false ||
    params.agentId !== binding.roleId ||
    params.sessionKey !== binding.sessionKey ||
    !binding.sessionKey.startsWith(`agent:${binding.roleId}:legal:`) ||
    params.idempotencyKey !== binding.operationId ||
    params.thinking !== binding.expected.effort ||
    Buffer.byteLength(params.message, "utf8") > 1_000_000 ||
    bytesHash(params.message) !== binding.submittedPromptHash ||
    Date.parse(binding.deadlineAt) <= now.getTime()
  ) {
    throw new Error("legal-evidence-ingress-binding");
  }
  assertRuntimeMatches(runtime, descriptor);
}

export function validateLegalEvidenceIngress(params: {
  descriptor: CaptureRequest;
  params: EvidenceIngressParams;
  peer: EvidencePeer;
  runtime: RuntimeIdentity;
  now?: Date;
}): ClientBinding {
  const client = resolveEvidenceClientBinding(params.peer, "operator.write");
  assertIngressMatches(params.descriptor, params.params, params.runtime, params.now ?? new Date());
  return client;
}

export function readExistingLegalEvidenceIngress(params: {
  store: EngineEvidenceStore;
  descriptor: CaptureRequest;
  params: EvidenceIngressParams;
  peer: EvidencePeer;
  runtime: RuntimeIdentity;
  activeOperationIds?: ReadonlySet<string>;
  now?: Date;
}): { envelope: EngineEnvelope; client: ClientBinding } | undefined {
  const client = validateLegalEvidenceIngress(params);
  let envelope: EngineEnvelope;
  try {
    envelope = params.store.read(params.descriptor.binding.operationId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (
    envelope.record.captureOrigin !== "runtime" ||
    envelope.record.bindingHash !== params.descriptor.bindingHash ||
    evidenceHash(envelope.record.binding) !== evidenceHash(params.descriptor.binding) ||
    evidenceHash(envelope.record.client) !== evidenceHash(client) ||
    evidenceHash(envelope.record.runtime) !== evidenceHash(params.runtime)
  ) {
    throw new Error("evidence-reservation-conflict");
  }
  if (
    envelope.record.state === "prepared" &&
    !params.activeOperationIds?.has(params.descriptor.binding.operationId)
  ) {
    envelope = markLegalEvidencePreparedUnknown(
      params.store,
      params.descriptor.binding.operationId,
    );
  }
  return { envelope, client };
}

export function reserveLegalEvidenceIngress(params: {
  store: EngineEvidenceStore;
  descriptor: CaptureRequest;
  params: EvidenceIngressParams;
  peer: EvidencePeer;
  runtime: RuntimeIdentity;
  activeOperationIds?: ReadonlySet<string>;
  now?: Date;
}): { created: boolean; envelope: EngineEnvelope; client: ClientBinding } {
  const now = params.now ?? new Date();
  const client = validateLegalEvidenceIngress({ ...params, now });
  const binding = params.descriptor.binding;
  const promptBytes = Buffer.from(params.params.message, "utf8");
  params.store.putBlob("submitted-prompt", promptBytes);
  const record: EngineReceipt = {
    schema: "quinn-legal-engine-evidence-v1",
    version: 1,
    captureOrigin: "runtime",
    operationId: binding.operationId,
    runtime: structuredClone(params.runtime),
    client,
    binding: structuredClone(binding),
    bindingHash: params.descriptor.bindingHash,
    preparedAt: now.toISOString(),
    state: "prepared",
    events: [],
    attempts: [],
    journal: params.store.putBlob("journal", Buffer.from("[]")),
  };
  const reservation = params.store.reserve(record);
  if (
    !reservation.created &&
    reservation.envelope.record.state === "prepared" &&
    !params.activeOperationIds?.has(binding.operationId)
  ) {
    reservation.envelope = markLegalEvidencePreparedUnknown(params.store, binding.operationId);
  }
  return { ...reservation, client };
}

export function markLegalEvidencePreparedUnknown(
  store: EngineEvidenceStore,
  operationId: string,
): EngineEnvelope {
  const current = store.read(operationId);
  if (current.record.state !== "prepared") {
    return current;
  }
  const record = structuredClone(current.record);
  record.state = "unknown";
  // A stranded reservation has no observed execution end time.
  delete record.endedAt;
  try {
    return store.commit(record, current.hash);
  } catch (error) {
    if (error instanceof Error && error.message === "evidence-engine-stale-phase") {
      return store.read(operationId);
    }
    throw error;
  }
}

function operationBlobs(record: EngineReceipt) {
  return [
    record.journal,
    ...record.attempts.flatMap((attempt) =>
      [
        attempt.requestBody,
        attempt.responseStream,
        attempt.terminal?.frame,
        attempt.providerText,
        attempt.assembledText,
      ].filter((blob) => blob !== undefined),
    ),
  ];
}

export function readLegalEvidenceBlob(params: {
  store: EngineEvidenceStore;
  operationId: string;
  blobHash: string;
  offset: number;
  length: number;
  peer: EvidencePeer;
}): EvidenceReadResult {
  const caller = resolveEvidenceClientBinding(params.peer, "operator.read");
  assertEvidenceSchema("Uuid", params.operationId);
  assertEvidenceSchema("Hash", params.blobHash);
  assertEvidenceSchema("EvidenceReadParams", {
    operationId: params.operationId,
    blobHash: params.blobHash,
    offset: params.offset,
    length: params.length,
  });
  const envelope = params.store.read(params.operationId);
  if (evidenceHash(envelope.record.client) !== evidenceHash(caller)) {
    throw new Error("legal-evidence-client-mismatch");
  }
  const blob = operationBlobs(envelope.record).find((entry) => entry.sha256 === params.blobHash);
  if (!blob || params.offset + params.length > blob.bytes) {
    throw new Error("legal-evidence-blob-not-in-operation");
  }
  const bytes = params.store.readBlob(blob).subarray(params.offset, params.offset + params.length);
  return {
    operationId: params.operationId,
    blobHash: params.blobHash,
    offset: params.offset,
    length: bytes.length,
    totalBytes: blob.bytes,
    dataBase64: bytes.toString("base64"),
  };
}

export function getLegalEvidenceCapabilities(reader: unknown): Capabilities | undefined {
  let runtime: RuntimeIdentity;
  try {
    runtime = readCurrentLegalEvidenceRuntime(reader);
  } catch {
    return undefined;
  }
  return {
    schemaVersion: 1,
    available: true,
    runtime: structuredClone(runtime),
    modelPolicy: "quinn-legal-single-request-v1",
    physicalRequestCeiling: 1,
    transport: "sse",
    holdReason: "none",
  };
}

export async function getLegalEvidenceCapabilitiesAsync(
  reader: unknown,
): Promise<Capabilities | undefined> {
  let runtime: RuntimeIdentity;
  try {
    runtime = await readCurrentLegalEvidenceRuntimeAsync(reader);
  } catch {
    return undefined;
  }
  return {
    schemaVersion: 1,
    available: true,
    runtime: structuredClone(runtime),
    modelPolicy: "quinn-legal-single-request-v1",
    physicalRequestCeiling: 1,
    transport: "sse",
    holdReason: "none",
  };
}

export function getLegalEvidenceOperation(params: {
  store: EngineEvidenceStore;
  operationId: string;
  peer: EvidencePeer;
  activeOperationIds?: ReadonlySet<string>;
}): {
  operationId: string;
  state: EngineReceipt["state"] | "unavailable";
  envelope?: EngineEnvelope;
} {
  const caller = resolveEvidenceClientBinding(params.peer, "operator.read");
  assertEvidenceSchema("EvidenceGetParams", { operationId: params.operationId });
  let envelope: EngineEnvelope;
  try {
    envelope = params.store.read(params.operationId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { operationId: params.operationId, state: "unavailable" };
    }
    throw error;
  }
  if (evidenceHash(envelope.record.client) !== evidenceHash(caller)) {
    throw new Error("legal-evidence-client-mismatch");
  }
  if (envelope.record.state === "prepared" && !params.activeOperationIds?.has(params.operationId)) {
    envelope = markLegalEvidencePreparedUnknown(params.store, params.operationId);
  }
  return { operationId: params.operationId, state: envelope.record.state, envelope };
}
