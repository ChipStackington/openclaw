import path from "node:path";
import {
  checkedDirectory,
  evidenceFileExists,
  readCheckedFile,
  withEvidenceLock,
  writeEvidenceFile,
} from "./files.js";
import { bytesHash, evidenceHash, evidenceJsonV1, parseEvidenceJson } from "./hash.js";
import { assertEvidenceSchema } from "./schema.js";
import type { Blob, EngineEnvelope, EngineReceipt } from "./types.js";

const LIMITS = {
  packet: 1_000_000,
  "submitted-prompt": 1_000_000,
  "request-body": 2_000_000,
  "response-stream": 16_000_000,
  "terminal-frame": 16_000_000,
  "provider-text": 1_000_000,
  "assembled-text": 1_000_000,
  journal: 512_000,
};
const NEXT: Record<EngineReceipt["state"], EngineReceipt["state"][]> = {
  prepared: ["running", "failed", "unknown"],
  running: ["running", "completed", "failed", "incomplete", "unknown"],
  completed: [],
  failed: [],
  incomplete: [],
  unknown: [],
};
const PINS = [
  "operationId",
  "captureOrigin",
  "binding",
  "bindingHash",
  "client",
  "runtime",
] as const;
export class EngineEvidenceStore {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
    this.directories();
  }
  private directories() {
    for (const directory of ["", "operations", "blobs", "locks"]) {
      checkedDirectory(path.join(this.root, directory), true);
    }
  }
  private file(id: string) {
    assertEvidenceSchema("Uuid", id);
    this.directories();
    return path.join(this.root, "operations", id + ".json");
  }
  putBlob(kind: Blob["kind"], bytes: Uint8Array): Blob {
    const blob: Blob = {
      kind,
      sha256: bytesHash(bytes),
      bytes: bytes.byteLength,
      encoding: kind === "response-stream" || kind === "terminal-frame" ? "binary" : "utf8",
    };
    assertEvidenceSchema("Blob", blob);
    this.directories();
    withEvidenceLock(path.join(this.root, "locks", blob.sha256 + ".lock"), () => {
      try {
        if (!this.readBlob(blob).equals(Buffer.from(bytes))) {
          throw new Error("evidence-immutable-conflict");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        writeEvidenceFile(path.join(this.root, "blobs", blob.sha256), bytes);
      }
    });
    return blob;
  }
  readBlob(blob: Blob): Buffer {
    assertEvidenceSchema("Blob", blob);
    this.directories();
    const bytes = readCheckedFile(path.join(this.root, "blobs", blob.sha256), LIMITS[blob.kind]);
    if (bytes.length !== blob.bytes || bytesHash(bytes) !== blob.sha256) {
      throw new Error("evidence-blob-integrity");
    }
    return bytes;
  }
  private validate(record: EngineReceipt): void {
    assertEvidenceSchema("EngineReceipt", record);
    const b = record.binding,
      r = record.runtime;
    if (
      record.operationId !== b.operationId ||
      record.bindingHash !== evidenceHash(b) ||
      r.installationId !== b.engineInstallationId ||
      r.engineRevision !== b.engineRevision ||
      r.engineBuildHash !== b.engineBuildHash ||
      r.adapterVersion !== b.engineAdapterVersion ||
      r.adapterPatchHash !== b.engineAdapterPatchHash ||
      r.adapterContentHash !== b.engineAdapterContentHash ||
      r.rolePolicyHash !== b.engineRolePolicyHash
    ) {
      throw new Error("evidence-engine-binding");
    }
    if (
      record.journal.kind !== "journal" ||
      !this.readBlob(record.journal).equals(Buffer.from(evidenceJsonV1(record.events)))
    ) {
      throw new Error("evidence-journal-integrity");
    }
    let at = Date.parse(record.preparedAt);
    const deadline = Date.parse(b.deadlineAt);
    if (at > deadline) {
      throw new Error("evidence-time-order");
    }
    for (const [index, event] of record.events.entries()) {
      const current = Date.parse(event.at);
      if (event.seq !== index + 1 || current < at || current > deadline) {
        throw new Error("evidence-event-order");
      }
      at = current;
    }
    if (
      record.endedAt &&
      (Date.parse(record.endedAt) < at || Date.parse(record.endedAt) > deadline)
    ) {
      throw new Error("evidence-time-order");
    }
    for (const attempt of record.attempts) {
      if (
        attempt.provider !== b.expected.provider ||
        attempt.model !== b.expected.model ||
        attempt.effort !== b.expected.effort ||
        attempt.requestBody.kind !== "request-body" ||
        Date.parse(attempt.preparedAt) < Date.parse(record.preparedAt) ||
        Date.parse(attempt.sendIntentAt) < Date.parse(attempt.preparedAt) ||
        Date.parse(attempt.sendIntentAt) > deadline
      ) {
        throw new Error("evidence-attempt-binding");
      }
      const material = [
        attempt.requestBody,
        attempt.responseStream,
        attempt.terminal?.frame,
        attempt.providerText,
        attempt.assembledText,
      ].filter((blob): blob is Blob => !!blob);
      for (const blob of material) {
        this.readBlob(blob);
      }
    }
    if (record.state === "completed" && record.selectedAttemptId !== record.attempts[0]?.id) {
      throw new Error("evidence-attempt-selected");
    }
  }
  private save(record: EngineReceipt): EngineEnvelope {
    const envelope = { record, hash: evidenceHash(record) },
      bytes = Buffer.from(evidenceJsonV1(envelope));
    if (bytes.length > 128_000) {
      throw new Error("evidence-manifest-limit");
    }
    writeEvidenceFile(this.file(record.operationId), bytes);
    return this.read(record.operationId);
  }
  read(id: string): EngineEnvelope {
    const envelope = parseEvidenceJson(readCheckedFile(this.file(id), 128_000)) as EngineEnvelope;
    assertEvidenceSchema("EngineEnvelope", envelope);
    if (envelope.hash !== evidenceHash(envelope.record) || envelope.record.operationId !== id) {
      throw new Error("evidence-engine-integrity");
    }
    this.validate(envelope.record);
    return envelope;
  }
  reserve(record: EngineReceipt): { created: boolean; envelope: EngineEnvelope } {
    this.validate(record);
    this.file(record.operationId);
    return withEvidenceLock(path.join(this.root, "locks", record.operationId + ".lock"), () => {
      if (evidenceFileExists(this.file(record.operationId))) {
        const existing = this.read(record.operationId);
        for (const field of PINS) {
          if (evidenceHash(existing.record[field]) !== evidenceHash(record[field])) {
            throw new Error("evidence-reservation-conflict");
          }
        }
        return { created: false, envelope: existing };
      }
      if (record.state !== "prepared" || record.attempts.length !== 0) {
        throw new Error("evidence-reservation-phase");
      }
      return { created: true, envelope: this.save(record) };
    });
  }
  commit(record: EngineReceipt, expectedHash: string): EngineEnvelope {
    this.validate(record);
    this.file(record.operationId);
    assertEvidenceSchema("Hash", expectedHash);
    return withEvidenceLock(path.join(this.root, "locks", record.operationId + ".lock"), () => {
      const current = this.read(record.operationId);
      if (current.hash !== expectedHash || !NEXT[current.record.state].includes(record.state)) {
        throw new Error("evidence-engine-stale-phase");
      }
      for (const field of [...PINS, "preparedAt"] as const) {
        if (evidenceHash(current.record[field]) !== evidenceHash(record[field])) {
          throw new Error("evidence-immutable-binding");
        }
      }
      if (
        current.record.events.length > record.events.length ||
        current.record.events.some((e, i) => evidenceHash(e) !== evidenceHash(record.events[i]))
      ) {
        throw new Error("evidence-journal-regressed");
      }
      if (current.record.attempts.length > record.attempts.length) {
        throw new Error("evidence-reservation-reset");
      }
      for (const [i, prior] of current.record.attempts.entries()) {
        const next = record.attempts[i];
        for (const key of Object.keys(prior) as (keyof typeof prior)[]) {
          if (key !== "state" && evidenceHash(prior[key]) !== evidenceHash(next[key])) {
            throw new Error("evidence-attempt-replaced");
          }
        }
        if (prior.state !== "send-intent" && prior.state !== next.state) {
          throw new Error("evidence-attempt-regressed");
        }
      }
      return this.save(record);
    });
  }
}
