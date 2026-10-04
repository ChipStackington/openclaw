// Generated from the approved schema by b-implementation-evidence/generate-types.mjs.
export type Hash = string;
export type Uuid = string;
export type Time = string;
export type Role =
  | "legal-practice"
  | "legal-facts"
  | "legal-research"
  | "legal-updates"
  | "legal-drafting"
  | "legal-verification"
  | "legal-strategy";
export type Origin = "runtime" | "development-fixture";
export type Model = "gpt-6.1-sol" | "gpt-6-astra";
export type Effort = "high" | "medium";
export type Scope = { tenantId: string; matterId: string };
export type Expected = {
  provider: "openai-codex";
  model: Model;
  effort: Effort;
  physicalRequestCeiling: 1;
};
export type Blob = {
  kind:
    | "packet"
    | "submitted-prompt"
    | "request-body"
    | "response-stream"
    | "terminal-frame"
    | "provider-text"
    | "assembled-text"
    | "journal";
  sha256: Hash;
  bytes: number;
  encoding: "utf8" | "binary";
};
export type AcceptancePolicy = {
  version: 2;
  evidenceSchema: 1;
  modelPolicyHash: Hash;
  reviewedImplementationHash: Hash;
};
export type DispatchBinding = {
  version: 1;
  operationId: Uuid;
  sessionKey: string;
  runId: Uuid;
  taskId: string;
  claimId: Uuid;
  reservationRevision: number;
  scope: Scope;
  requesterId: string;
  dispatchActorId: string;
  roleId: Role;
  runtimeHash: Hash;
  engineInstallationId: Uuid;
  engineBuildHash: Hash;
  contractHash: Hash;
  modelPolicyHash: Hash;
  wholeContextHash: Hash;
  taskContextHash: Hash;
  planContextHash: Hash;
  sourceSelectionHash: Hash;
  sourceIdentitiesHash: Hash;
  dependencySnapshotHash: Hash;
  packetHash: Hash;
  submittedPromptHash: Hash;
  expected: Expected;
  deadlineAt: Time;
  engineRolePolicyHash: Hash;
  reviewedImplementationHash: Hash;
  engineRevision: string;
  engineAdapterVersion: "0.57.1";
  engineAdapterPatchHash: Hash;
  engineAdapterContentHash: Hash;
};
export type CaptureRequest = {
  schema: "quinn-legal-model-evidence-v1";
  modelPolicy: "quinn-legal-single-request-v1";
  binding: DispatchBinding;
  bindingHash: Hash;
};
export type RuntimeIdentity = {
  installationId: Uuid;
  engineRevision: string;
  engineBuildHash: Hash;
  adapterVersion: "0.57.1";
  adapterPatchHash: Hash;
  rolePolicyHash: Hash;
  adapterContentHash: Hash;
};
export type ClientBinding = {
  deviceId: string;
  clientRole: "operator";
  clientMode: "cli";
  deviceBindingHash: Hash;
};
export type DecisionEvent = {
  seq: number;
  at: Time;
  kind:
    | "candidate-selected"
    | "candidate-skipped"
    | "runner-started"
    | "wire-reserved"
    | "send-intent"
    | "response-observed"
    | "terminal-observed"
    | "retry-denied"
    | "compaction-denied"
    | "policy-held"
    | "capture-failed"
    | "sealed";
  candidateIndex?: number;
  runnerIndex?: number;
  wireOrdinal?: 1;
  reason?:
    | "none"
    | "provider-failed"
    | "incomplete"
    | "aborted"
    | "transport-unknown"
    | "unsupported-transport"
    | "metadata-mismatch"
    | "output-mismatch"
    | "policy-drift"
    | "capture-io"
    | "evidence-limit"
    | "retry-denied";
};
export type Terminal = {
  event: "response.completed" | "response.done";
  responseId: string;
  model: Model;
  status: "completed";
  observedEffort: Effort | null;
  frame: Blob;
};
export type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
};
export type ExecutionSummary = {
  aborted: boolean;
  compactions: number;
  toolCalls: number;
  messagingSends: number;
  continuations: number;
  thinkingDowngrades: number;
  authRotations: number;
};
export type WireAttempt = {
  id: Uuid;
  ordinal: 1;
  candidateIndex: number;
  runnerIndex: number;
  providerInvocationIndex: number;
  adapterHttpAttemptIndex: 0;
  provider: "openai-codex";
  model: Model;
  effort: Effort;
  transport: "sse";
  requestBody: Blob;
  preparedAt: Time;
  sendIntentAt: Time;
  responseObservedAt?: Time;
  httpStatus?: number;
  state: "send-intent" | "completed" | "failed" | "unknown";
  responseStream?: Blob;
  terminal?: Terminal;
  projectionPolicy?: "single-assistant-output-v1";
  providerText?: Blob;
  assembledText?: Blob;
  adapterStopReason?: "stop";
  usage?: Usage;
  endpointClass: "chatgpt-codex-backend";
  method: "POST";
};
export type EngineReceipt = {
  schema: "quinn-legal-engine-evidence-v1";
  version: 1;
  captureOrigin: Origin;
  operationId: Uuid;
  runtime: RuntimeIdentity;
  client: ClientBinding;
  binding: DispatchBinding;
  bindingHash: Hash;
  preparedAt: Time;
  endedAt?: Time;
  state: "prepared" | "running" | "completed" | "failed" | "incomplete" | "unknown";
  events: DecisionEvent[];
  attempts: WireAttempt[];
  selectedAttemptId?: Uuid;
  journal: Blob;
  holdReason?:
    | "none"
    | "provider-failed"
    | "incomplete"
    | "aborted"
    | "transport-unknown"
    | "unsupported-transport"
    | "metadata-mismatch"
    | "output-mismatch"
    | "policy-drift"
    | "capture-io"
    | "evidence-limit"
    | "retry-denied";
  executionSummary?: ExecutionSummary;
};
export type EngineEnvelope = { record: EngineReceipt; hash: Hash };
export type ApplicationOperation = {
  version: 2;
  id: Uuid;
  revision: number;
  captureOrigin: Origin;
  binding: DispatchBinding;
  bindingHash: Hash;
  preparedAt: Time;
  phase: "prepared" | "bound" | "submitted" | "uncertain" | "completed" | "failed";
  preparedMaterial: Blob[];
  engineReceiptHash?: Hash;
  importedMaterial?: Blob[];
  assembledText?: Blob;
  completedAt?: Time;
  holdReason?:
    | "none"
    | "missing-evidence"
    | "authorization-lost"
    | "source-stale"
    | "contract-stale"
    | "output-invalid"
    | "provider-held"
    | "transport-unknown"
    | "storage-unavailable";
};
export type AuthorizationObservation = {
  actorId: string;
  permission: "approvals:decide";
  checkedAt: Time;
};
export type AcceptanceReceipt = {
  schema: "quinn-legal-acceptance-v1";
  version: 1;
  captureOrigin: Origin;
  scope: Scope;
  runId: Uuid;
  taskId: string;
  claimId: Uuid;
  operationId: Uuid;
  dispatchBindingHash: Hash;
  engineReceiptHash: Hash;
  operationRecordHash: Hash;
  contractHash: Hash;
  modelPolicyHash: Hash;
  wholeContextHash: Hash;
  taskContextHash: Hash;
  planContextHash: Hash;
  sourceSelectionHash: Hash;
  sourceIdentitiesHash: Hash;
  dependencySnapshotHash: Hash;
  packetHash: Hash;
  submittedPromptHash: Hash;
  rawStreamHash: Hash;
  terminalFrameHash: Hash;
  providerTextHash: Hash;
  assembledTextHash: Hash;
  normalizedOutputHash: Hash;
  outputStatus: "completed" | "partial";
  expected: Expected;
  terminal: Terminal;
  acceptedBy: string;
  authorization: AuthorizationObservation;
  acceptedAt: Time;
  committedRunRevision: number;
  physicalReservations: 1;
  crossRunEligible: boolean;
  reviewedImplementationHash: Hash;
};
export type AcceptanceEnvelope = { record: AcceptanceReceipt; hash: Hash };
export type EvidenceCapabilityParams = Record<string, never>;
export type EvidenceGetParams = { operationId: Uuid };
export type EvidenceReadParams = {
  operationId: Uuid;
  blobHash: Hash;
  offset: number;
  length: number;
};
export type EvidenceReadResult = {
  operationId: Uuid;
  blobHash: Hash;
  offset: number;
  length: number;
  totalBytes: number;
  dataBase64: string;
};
export type Capabilities = {
  schemaVersion: 1;
  available: boolean;
  runtime: RuntimeIdentity;
  modelPolicy: "quinn-legal-single-request-v1";
  physicalRequestCeiling: 1;
  transport: "sse";
  holdReason: "none" | "capture-unavailable" | "unclean-state" | "unsupported-build";
};
export type EvidenceGetResult = {
  operationId: Uuid;
  state: "unavailable" | "prepared" | "running" | "completed" | "failed" | "incomplete" | "unknown";
  envelope?: EngineEnvelope;
};
export type ReviewedImplementation = {
  schema: "quinn-legal-reviewed-implementation-v1";
  version: 1;
  artifactOrigin: "reviewed-build" | "development-fixture";
  engineRevision: string;
  engineBuildHash: Hash;
  adapterVersion: "0.57.1";
  adapterPatchHash: Hash;
  adapterContentHash: Hash;
};
export type ReviewedImplementationEnvelope = { record: ReviewedImplementation; hash: Hash };
