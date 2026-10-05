import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { checkedDirectory, readCheckedFile } from "./files.js";
import { bytesHash, evidenceJsonV1, parseEvidenceJson } from "./hash.js";
import { assertCurrentLegalEvidenceRuntime, type LegalEvidenceRuntimeReader } from "./runtime.js";
import { EngineEvidenceStore } from "./store.js";
import type {
  DecisionEvent,
  EngineEnvelope,
  EngineReceipt,
  ExecutionSummary,
  Expected,
  Terminal,
  Usage,
  WireAttempt,
} from "./types.js";

type Hold = NonNullable<EngineReceipt["holdReason"]>;
type WireRequest = {
  body: string;
  url: string;
  method: "POST";
  transport: "sse";
  model: string;
  provider: string;
  httpAttemptIndex: number;
};
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
export function applyLegalCaptureSettings(settings: {
  applyOverrides: (value: {
    retry: { enabled: boolean };
    compaction: { enabled: boolean };
  }) => void;
}): void {
  settings.applyOverrides({ retry: { enabled: false }, compaction: { enabled: false } });
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legal-evidence-object");
  }
  return value as Record<string, unknown>;
};
function losslessUtf8(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== value) {
    throw new Error("legal-evidence-utf8-loss");
  }
  return bytes;
}
function frameData(bytes: Uint8Array): Record<string, unknown> | undefined {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const boundary = /\r?\n\r?\n/.exec(text);
  if (!boundary || boundary.index + boundary[0].length !== text.length) {
    throw new Error("legal-evidence-frame-boundary");
  }
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data || data === "[DONE]") {
    return undefined;
  }
  return object(parseEvidenceJson(Buffer.from(data), 16_000_000));
}
/** Reparse original bytes independently of adapter model/status normalization. */
export function projectLegalTerminal(
  bytes: Uint8Array,
  expected: Expected,
): Omit<Terminal, "frame"> & { text: string; usage: Usage } {
  if (bytes.byteLength > 16_000_000) {
    throw new Error("legal-evidence-limit");
  }
  const event = frameData(bytes);
  if (!event || (event.type !== "response.completed" && event.type !== "response.done")) {
    throw new Error("legal-evidence-terminal");
  }
  const response = object(event.response);
  if (
    typeof response.id !== "string" ||
    !response.id.trim() ||
    response.id.length > 256 ||
    response.model !== expected.model ||
    response.status !== "completed" ||
    (response.error !== undefined && response.error !== null) ||
    (response.incomplete_details !== undefined && response.incomplete_details !== null) ||
    !Array.isArray(response.output)
  ) {
    throw new Error("legal-evidence-terminal-facts");
  }
  let assistant: Record<string, unknown> | undefined;
  for (const value of response.output) {
    const item = object(value);
    if (item.type === "reasoning") {
      continue;
    }
    if (
      assistant ||
      item.type !== "message" ||
      item.role !== "assistant" ||
      item.status !== "completed" ||
      !Array.isArray(item.content) ||
      item.content.length === 0
    ) {
      throw new Error("legal-evidence-output");
    }
    assistant = item;
  }
  if (!assistant) {
    throw new Error("legal-evidence-output");
  }
  let text = "";
  for (const value of assistant.content as unknown[]) {
    const part = object(value);
    if (part.type !== "output_text" || typeof part.text !== "string") {
      throw new Error("legal-evidence-output");
    }
    text += part.text;
  }
  const textBytes = losslessUtf8(text);
  if (textBytes.length > 1_000_000) {
    throw new Error("legal-evidence-limit");
  }
  let observedEffort: Expected["effort"] | null = null;
  if (response.reasoning !== undefined && response.reasoning !== null) {
    const reasoning = object(response.reasoning);
    if (Object.hasOwn(reasoning, "effort")) {
      if (reasoning.effort !== expected.effort) {
        throw new Error("legal-evidence-effort");
      }
      observedEffort = expected.effort;
    }
  }
  const rawUsage =
    response.usage === undefined || response.usage === null ? {} : object(response.usage);
  const token = (value: unknown): number | null => {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("legal-evidence-usage");
    }
    return value;
  };
  const details =
    rawUsage.input_tokens_details === undefined || rawUsage.input_tokens_details === null
      ? {}
      : object(rawUsage.input_tokens_details);
  const usage: Usage = {
    inputTokens: token(rawUsage.input_tokens),
    outputTokens: token(rawUsage.output_tokens),
    cachedInputTokens: token(details.cached_tokens),
    totalTokens: token(rawUsage.total_tokens),
  };
  return {
    event: event.type,
    responseId: response.id,
    model: expected.model,
    status: "completed",
    observedEffort,
    text,
    usage,
  };
}
function originalTerminal(stream: Uint8Array): Buffer {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stream);
  let start = 0;
  let terminal: Buffer | undefined;
  for (const match of text.matchAll(/\r?\n\r?\n/g)) {
    const end = match.index + match[0].length;
    const frame = Buffer.from(text.slice(start, end));
    start = end;
    const event = frameData(frame);
    if (event?.type === "response.completed" || event?.type === "response.done") {
      if (terminal) {
        throw new Error("legal-evidence-duplicate-terminal");
      }
      terminal = frame;
    }
  }
  if (start !== text.length || !terminal) {
    throw new Error("legal-evidence-incomplete-stream");
  }
  return terminal;
}

/** One private context and one permanent reservation, never reconstructed for execution. */
export class LegalEvidenceCapture {
  private envelope: EngineEnvelope;
  private held?: Hold;
  private candidateCount = 0;
  private runnerCount = 0;
  private invocationCount = 0;
  private reserved = false;
  private spool?: { file: string; fd: number | undefined; bytes: number; ino: number; dev: number };
  private terminal?: { bytes: Buffer; projection: ReturnType<typeof projectLegalTerminal> };
  private complete?: WireAttempt;
  private constructor(
    private readonly store: EngineEvidenceStore,
    envelope: EngineEnvelope,
    private readonly submittedAssignment: string,
    private readonly readRuntime: LegalEvidenceRuntimeReader,
  ) {
    this.envelope = envelope;
  }
  static create(
    store: EngineEvidenceStore,
    record: EngineReceipt,
    submittedAssignment: string,
    readRuntime: LegalEvidenceRuntimeReader,
  ): LegalEvidenceCapture {
    if (typeof submittedAssignment !== "string" || submittedAssignment.length === 0) {
      throw new Error("legal-evidence-assignment-binding");
    }
    const submittedBytes = losslessUtf8(submittedAssignment);
    if (
      submittedBytes.byteLength > 1_000_000 ||
      bytesHash(submittedBytes) !== record.binding.submittedPromptHash
    ) {
      throw new Error("legal-evidence-assignment-binding");
    }
    assertCurrentLegalEvidenceRuntime(readRuntime, record.runtime);
    const reservation = store.reserve(record);
    if (!reservation.created) {
      throw new Error("legal-evidence-operation-already-reserved");
    }
    return LegalEvidenceCapture.fromReserved(
      store,
      reservation.envelope,
      submittedAssignment,
      readRuntime,
    );
  }
  static fromReserved(
    store: EngineEvidenceStore,
    envelope: EngineEnvelope,
    submittedAssignment: string,
    readRuntime: LegalEvidenceRuntimeReader,
  ): LegalEvidenceCapture {
    if (typeof submittedAssignment !== "string" || submittedAssignment.length === 0) {
      throw new Error("legal-evidence-assignment-binding");
    }
    const submittedBytes = losslessUtf8(submittedAssignment);
    const durable = store.read(envelope.record.operationId);
    if (
      submittedBytes.byteLength > 1_000_000 ||
      bytesHash(submittedBytes) !== envelope.record.binding.submittedPromptHash ||
      envelope.record.state !== "prepared" ||
      envelope.record.attempts.length !== 0 ||
      durable.hash !== envelope.hash
    ) {
      throw new Error("legal-evidence-assignment-binding");
    }
    assertCurrentLegalEvidenceRuntime(readRuntime, envelope.record.runtime);
    return new LegalEvidenceCapture(store, envelope, submittedAssignment, readRuntime);
  }
  get binding() {
    return structuredClone(this.envelope.record.binding);
  }
  get providerContinuations() {
    return Math.max(0, this.invocationCount - 1);
  }
  private guard<T>(action: () => T): T {
    if (this.held) {
      throw new Error("legal-evidence-held");
    }
    try {
      return action();
    } catch (error) {
      this.held ??= "capture-io";
      this.closeSpool();
      throw error;
    }
  }
  private reject(reason: Hold): never {
    this.held = reason;
    throw new Error("legal-evidence-held");
  }
  private save(record: EngineReceipt) {
    this.envelope = this.store.commit(record, this.envelope.hash);
  }
  private event(
    record: EngineReceipt,
    kind: DecisionEvent["kind"],
    reason?: DecisionEvent["reason"],
  ) {
    if (record.events.length >= 64) {
      this.reject("evidence-limit");
    }
    const event: DecisionEvent = {
      seq: record.events.length + 1,
      at: new Date().toISOString(),
      kind,
    };
    if (reason) {
      event.reason = reason;
    }
    record.events.push(event);
    const bytes = Buffer.from(evidenceJsonV1(record.events));
    if (bytes.length > 512_000) {
      this.reject("evidence-limit");
    }
    record.journal = this.store.putBlob("journal", bytes);
  }
  candidate(provider: string, model: string, effort: string): void {
    this.guard(() => {
      const record = structuredClone(this.envelope.record),
        expected = record.binding.expected;
      if (
        ++this.candidateCount !== 1 ||
        provider !== expected.provider ||
        model !== expected.model ||
        effort !== expected.effort
      ) {
        this.reject("metadata-mismatch");
      }
      record.state = "running";
      this.event(record, "candidate-selected");
      this.save(record);
    });
  }
  runnerStarted(provider?: string, model?: string, effort?: string): void {
    this.guard(() => {
      if (this.candidateCount !== 1 || ++this.runnerCount !== 1) {
        this.reject("retry-denied");
      }
      const expected = this.binding.expected;
      if (
        (provider !== undefined && provider !== expected.provider) ||
        (model !== undefined && model !== expected.model) ||
        (effort !== undefined && effort !== expected.effort)
      ) {
        this.reject("metadata-mismatch");
      }
      const record = structuredClone(this.envelope.record);
      this.event(record, "runner-started");
      this.save(record);
    });
  }
  deny(kind: "retry-denied" | "compaction-denied" = "retry-denied"): never {
    this.guard(() => {
      const record = structuredClone(this.envelope.record);
      this.event(record, kind, "retry-denied");
      this.save(record);
    });
    return this.reject("retry-denied");
  }
  wrapStream(inner: StreamFn): StreamFn {
    return (model, context, options) => {
      this.guard(() => {
        if (
          ++this.invocationCount !== 1 ||
          model.api !== "openai-codex-responses" ||
          model.provider !== this.binding.expected.provider ||
          model.id !== this.binding.expected.model
        ) {
          this.deny();
        }
      });
      return inner(model, context, {
        ...options,
        transport: "sse",
        legalEvidenceObserver: this.observer,
      } as typeof options);
    };
  }
  private openSpool() {
    const directory = path.join(this.store.root, "streams");
    checkedDirectory(directory, true);
    const file = path.join(directory, this.envelope.record.operationId + ".part");
    const fd = fs.openSync(file, "wx", 0o600),
      stat = fs.fstatSync(fd);
    this.spool = { file, fd, bytes: 0, ino: stat.ino, dev: stat.dev };
  }
  private flushStream(): Buffer {
    if (!this.spool) {
      this.reject("incomplete");
    }
    if (this.spool.fd !== undefined) {
      fs.fsyncSync(this.spool.fd);
    }
    const bytes = readCheckedFile(this.spool.file, 16_000_000);
    if (bytes.length !== this.spool.bytes) {
      this.reject("capture-io");
    }
    return bytes;
  }
  private closeSpool() {
    if (this.spool?.fd !== undefined) {
      const fd = this.spool.fd;
      this.spool.fd = undefined;
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  readonly observer = {
    onRequest: async (request: WireRequest): Promise<void> =>
      this.guard(() => {
        assertCurrentLegalEvidenceRuntime(this.readRuntime, this.envelope.record.runtime);
        if (this.reserved || this.envelope.record.attempts.length || this.runnerCount !== 1) {
          this.deny();
        }
        const expected = this.binding.expected,
          bytes = Buffer.from(request.body);
        if (bytes.length > 2_000_000) {
          this.reject("evidence-limit");
        }
        const body = object(parseEvidenceJson(bytes, 2_000_000)),
          reasoning = object(body.reasoning);
        if (
          request.url !== endpoint ||
          request.method !== "POST" ||
          request.transport !== "sse" ||
          request.httpAttemptIndex !== 0 ||
          request.provider !== expected.provider ||
          request.model !== expected.model ||
          body.model !== expected.model ||
          reasoning.effort !== expected.effort ||
          body.stream !== true ||
          (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 0)) ||
          !Array.isArray(body.input) ||
          body.input.length === 0
        ) {
          this.reject("metadata-mismatch");
        }
        let assignmentCount = 0;
        let assignment = "";
        for (const value of body.input) {
          const item = object(value);
          if (item.type === "function_call" || item.type === "function_call_output") {
            this.reject("metadata-mismatch");
          }
          if (item.type === "reasoning") {
            if (item.content !== undefined) {
              this.reject("metadata-mismatch");
            }
            continue;
          }
          if (
            (item.type !== undefined && item.type !== "message") ||
            !["assistant", "developer", "system", "user"].includes(String(item.role))
          ) {
            this.reject("metadata-mismatch");
          }
          if (typeof item.content === "string") {
            if (item.role === "user") {
              assignmentCount++;
              assignment = item.content;
            }
            continue;
          }
          if (!Array.isArray(item.content) || item.content.length === 0) {
            this.reject("metadata-mismatch");
          }
          for (const value of item.content) {
            const part = object(value);
            if (
              (part.type !== "input_text" && part.type !== "output_text") ||
              typeof part.text !== "string" ||
              (item.role === "user" && part.type !== "input_text")
            ) {
              this.reject("metadata-mismatch");
            }
            if (item.role === "user") {
              assignment += part.text;
            }
          }
          if (item.role === "user") {
            assignmentCount++;
          }
        }
        if (assignmentCount !== 1 || assignment !== this.submittedAssignment) {
          this.reject("metadata-mismatch");
        }
        // An uncertain commit consumes the in-memory budget before any storage write.
        this.reserved = true;
        const record = structuredClone(this.envelope.record),
          at = new Date().toISOString();
        const requestBody = this.store.putBlob("request-body", bytes);
        record.attempts = [
          {
            id: randomUUID(),
            ordinal: 1,
            candidateIndex: 0,
            runnerIndex: 0,
            providerInvocationIndex: 0,
            adapterHttpAttemptIndex: 0,
            provider: expected.provider,
            model: expected.model,
            effort: expected.effort,
            transport: "sse",
            requestBody,
            preparedAt: at,
            sendIntentAt: at,
            state: "send-intent",
            endpointClass: "chatgpt-codex-backend",
            method: "POST",
          },
        ];
        this.event(record, "wire-reserved");
        this.event(record, "send-intent");
        this.save(record);
      }),
    onResponse: async (response: { status: number; contentType: string | null }): Promise<void> =>
      this.guard(() => {
        if (
          !this.reserved ||
          !Number.isInteger(response.status) ||
          response.status < 100 ||
          response.status > 599
        ) {
          this.reject("metadata-mismatch");
        }
        const record = structuredClone(this.envelope.record),
          attempt = record.attempts[0];
        if (attempt.httpStatus !== undefined) {
          this.deny();
        }
        attempt.httpStatus = response.status;
        attempt.responseObservedAt = new Date().toISOString();
        this.event(record, "response-observed");
        this.save(record);
        if (response.status >= 200 && response.status < 300) {
          if (response.status !== 200) {
            this.reject("provider-failed");
          }
          if (
            !response.contentType ||
            response.contentType.length > 256 ||
            response.contentType.split(";")[0].trim().toLowerCase() !== "text/event-stream"
          ) {
            this.reject("unsupported-transport");
          }
          this.openSpool();
        }
      }),
    onChunk: async (bytes: Uint8Array): Promise<void> =>
      this.guard(() => {
        if (!this.spool || this.spool.fd === undefined || this.complete) {
          this.reject("incomplete");
        }
        if (this.spool.bytes + bytes.byteLength > 16_000_000) {
          this.reject("evidence-limit");
        }
        checkedDirectory(path.dirname(this.spool.file));
        const named = fs.lstatSync(this.spool.file),
          opened = fs.fstatSync(this.spool.fd);
        if (
          named.isSymbolicLink() ||
          named.nlink !== 1 ||
          opened.nlink !== 1 ||
          named.ino !== this.spool.ino ||
          named.dev !== this.spool.dev ||
          opened.ino !== this.spool.ino ||
          opened.size !== this.spool.bytes
        ) {
          this.reject("capture-io");
        }
        let offset = 0;
        while (offset < bytes.length) {
          const written = fs.writeSync(this.spool.fd, bytes, offset, bytes.length - offset);
          if (!written) {
            this.reject("capture-io");
          }
          offset += written;
        }
        this.spool.bytes += bytes.length;
      }),
    onTerminal: async (bytes: Uint8Array): Promise<void> =>
      this.guard(() => {
        if (this.terminal || !this.spool) {
          this.reject("metadata-mismatch");
        }
        try {
          this.terminal = {
            bytes: Buffer.from(bytes),
            projection: projectLegalTerminal(bytes, this.binding.expected),
          };
        } catch {
          this.reject("metadata-mismatch");
        }
        const record = structuredClone(this.envelope.record);
        this.event(record, "terminal-observed");
        this.save(record);
      }),
    onComplete: async (result: {
      text: string;
      stopReason: string;
      toolCalls: number;
    }): Promise<void> =>
      this.guard(() => {
        if (
          !this.terminal ||
          this.complete ||
          result.stopReason !== "stop" ||
          result.toolCalls !== 0 ||
          result.text !== this.terminal.projection.text
        ) {
          this.reject("output-mismatch");
        }
        const bytes = this.flushStream();
        if (bytesHash(originalTerminal(bytes)) !== bytesHash(this.terminal.bytes)) {
          this.reject("metadata-mismatch");
        }
        const { text, usage, ...projection } = this.terminal.projection,
          textBytes = losslessUtf8(text),
          assembledBytes = losslessUtf8(result.text);
        this.complete = {
          ...this.envelope.record.attempts[0],
          state: "completed",
          responseStream: this.store.putBlob("response-stream", bytes),
          terminal: {
            ...projection,
            frame: this.store.putBlob("terminal-frame", this.terminal.bytes),
          },
          projectionPolicy: "single-assistant-output-v1",
          providerText: this.store.putBlob("provider-text", textBytes),
          assembledText: this.store.putBlob("assembled-text", assembledBytes),
          adapterStopReason: "stop",
          usage,
        };
        this.closeSpool();
      }),
    onFailure: async (reason: Hold): Promise<void> => {
      this.held ??= reason;
      if (this.envelope.record.state !== "running" && this.envelope.record.state !== "prepared") {
        return;
      }
      try {
        const record = structuredClone(this.envelope.record);
        if (record.attempts[0]) {
          record.attempts[0].state = reason === "transport-unknown" ? "unknown" : "failed";
          if (this.spool) {
            record.attempts[0].responseStream = this.store.putBlob(
              "response-stream",
              this.flushStream(),
            );
          }
        }
        record.state = reason === "transport-unknown" ? "unknown" : "failed";
        record.holdReason = this.held;
        this.event(record, "capture-failed", this.held);
        record.endedAt = new Date().toISOString();
        this.save(record);
      } finally {
        this.closeSpool();
      }
    },
    onRetryDenied: async (): Promise<void> =>
      this.guard(() => {
        const record = structuredClone(this.envelope.record);
        this.event(record, "retry-denied", "retry-denied");
        this.save(record);
      }),
  };
  finishRunner(summary: ExecutionSummary): void {
    this.guard(() => {
      if (
        !this.complete ||
        summary.aborted ||
        summary.compactions ||
        summary.toolCalls ||
        summary.messagingSends ||
        summary.continuations ||
        summary.thinkingDowngrades ||
        summary.authRotations
      ) {
        this.reject("retry-denied");
      }
      const record = structuredClone(this.envelope.record);
      record.attempts = [this.complete];
      record.selectedAttemptId = this.complete.id;
      record.executionSummary = structuredClone(summary);
      record.state = "completed";
      record.holdReason = "none";
      this.event(record, "sealed");
      record.endedAt = new Date().toISOString();
      assertCurrentLegalEvidenceRuntime(this.readRuntime, record.runtime);
      this.save(record);
    });
  }
}
