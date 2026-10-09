import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { checkedDirectory, readCheckedFile } from "./files.js";
import { bytesHash, evidenceHash, parseEvidenceJson } from "./hash.js";
import { createBoundaryVerifier, type BoundaryPlan } from "./installation-boundary.js";
import type { MaterialInventory } from "./material.js";

// A separate whole-installation contract. Do not change the v1 material reader's bounds.
const limits = {
  entries: 400_000,
  files: 200_000,
  depth: 64,
  fileBytes: 1_073_741_824,
  totalBytes: 17_179_869_184,
  manifestBytes: 67_108_864,
};
type Entry = { path: string } & (
  | { kind: "directory" }
  | { kind: "file"; size: number; sha256: string }
  | { kind: "link"; target: string; realpath: string; targetKind: "directory" | "file" }
);
export type InstallationManifest = { version: 1; entries: Entry[] };
type Snapshot = Map<string, string>;
export type InstallationGuard = Readonly<{
  root: string;
  manifestHash: string;
  verify: () => void;
  refuse: () => never;
  assertFile: (file: string) => string;
}>;
function fail(): never {
  throw new Error("legal-evidence-installation-drift");
}
const stamp = (s: fs.BigIntStats): string =>
  [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
const stat = (p: string) => fs.lstatSync(p, { bigint: true });
function relative(root: string, file: string): string {
  const value = path.relative(root, file).split(path.sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || path.isAbsolute(value)) {
    fail();
  }
  return value;
}
function safePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !value ||
    value
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[\\:]/.test(p) ||
          Array.from(p).some((c) => c.charCodeAt(0) < 32),
      )
  ) {
    fail();
  }
}
function hashFile(
  file: string,
  before: fs.BigIntStats,
  buffer = Buffer.allocUnsafe(1_048_576),
): string {
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limits.fileBytes)) {
    fail();
  }
  const fd = fs.openSync(file, "r");
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before)) {
      fail();
    }
    const hash = createHash("sha256");
    let length = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, length);
      if (!n) {
        break;
      }
      length += n;
      if (length > limits.fileBytes || BigInt(length) > before.size) {
        fail();
      }
      hash.update(buffer.subarray(0, n));
    }
    if (
      BigInt(length) !== before.size ||
      stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before) ||
      stamp(stat(file)) !== stamp(before) ||
      stat(file).isSymbolicLink()
    ) {
      fail();
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

// The bootstrap workers execute only this embedded built-in-only verifier. They do
// not inherit preload arguments or import engine/provider modules. All workers
// finish before the second topology scan and before any guard is published.
const bootstrapWorker = String.raw`
const {workerData}=require('node:worker_threads');
const status=new Int32Array(workerData.status), hashes=new Uint8Array(workerData.hashes);
try {
  const fs=require('node:fs'), path=require('node:path'), {createHash}=require('node:crypto');
  const stamp=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
  const buffer=Buffer.allocUnsafe(1048576);
  for(const entry of workerData.files){
    const file=path.join(workerData.root,entry.path), before=fs.lstatSync(file,{bigint:true});
    if(!before.isFile() || before.isSymbolicLink() || before.nlink!==1n || stamp(before)!==entry.stamp){throw Error('drift');}
    const fd=fs.openSync(file,'r');
    try {
      if(stamp(fs.fstatSync(fd,{bigint:true}))!==entry.stamp){throw Error('drift');}
      const hash=createHash('sha256');let length=0;
      for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,length);if(!n)break;length+=n;
        if(length>1073741824 || BigInt(length)>before.size){throw Error('drift');}hash.update(buffer.subarray(0,n));}
      const named=fs.lstatSync(file,{bigint:true});
      if(BigInt(length)!==before.size || stamp(fs.fstatSync(fd,{bigint:true}))!==entry.stamp || stamp(named)!==entry.stamp || named.isSymbolicLink()){throw Error('drift');}
      hashes.set(hash.digest(),entry.index*32);
    } finally {fs.closeSync(fd);}
  }
  Atomics.store(status,workerData.slot,1);
} catch {Atomics.store(status,workerData.slot,-1);}
Atomics.notify(status,workerData.slot);
`;
function hashInstallationFiles(root: string, entries: Entry[], snapshot: Snapshot): void {
  const files = entries.filter(
    (e): e is Entry & { kind: "file"; size: number; sha256: string } => e.kind === "file",
  );
  if (files.length < 256) {
    const buffer = Buffer.allocUnsafe(1_048_576);
    for (const entry of files) {
      const file = path.join(root, entry.path),
        before = stat(file);
      if (stamp(before) !== snapshot.get(entry.path)) {
        fail();
      }
      entry.sha256 = hashFile(file, before, buffer);
    }
    return;
  }
  const hashes = new SharedArrayBuffer(files.length * 32),
    statusBuffer = new SharedArrayBuffer(4 * 4);
  const status = new Int32Array(statusBuffer),
    workers: Worker[] = [];
  const started = Date.now();
  try {
    for (let slot = 0; slot < 4; slot++) {
      const batch = files.flatMap((entry, index) =>
        index % 4 === slot ? [{ path: entry.path, index, stamp: snapshot.get(entry.path) }] : [],
      );
      const worker = new Worker(bootstrapWorker, {
        eval: true,
        execArgv: [],
        workerData: { root, files: batch, hashes, status: statusBuffer, slot },
      });
      worker.on("error", () => {});
      worker.unref();
      workers.push(worker);
    }
    for (;;) {
      const states = [0, 1, 2, 3].map((slot) => Atomics.load(status, slot));
      if (states.some((s) => s < 0) || Date.now() - started > 600_000) {
        fail();
      }
      const pending = states.findIndex((s) => s === 0);
      if (pending === -1) {
        break;
      }
      Atomics.wait(status, pending, 0, 1000);
    }
    const bytes = Buffer.from(hashes);
    files.forEach((entry, index) => {
      entry.sha256 = bytes.subarray(index * 32, (index + 1) * 32).toString("hex");
    });
  } finally {
    for (const worker of workers) {
      void worker.terminate();
    }
  }
}

function scan(
  root: string,
  hashFiles: boolean,
): { manifest: InstallationManifest; snapshot: Snapshot } {
  checkedDirectory(root);
  const entries: Entry[] = [],
    snapshot: Snapshot = new Map();
  let files = 0,
    total = 0;
  // Root ancestors are outside manifest membership but may never become links or change identity.
  let ancestor = root;
  for (;;) {
    const s = stat(ancestor);
    if (!s.isDirectory() || s.isSymbolicLink()) {
      fail();
    }
    snapshot.set("absolute:" + ancestor, [s.dev, s.ino, s.mode].join(":"));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    ancestor = parent;
  }
  function walk(dir: string, rel: string, depth: number): void {
    if (depth > limits.depth) {
      fail();
    }
    snapshot.set(rel, stamp(stat(dir)));
    for (const name of fs.readdirSync(dir).toSorted()) {
      const p = path.join(dir, name),
        r = rel ? rel + "/" + name : name;
      safePath(r);
      const s = stat(p);
      snapshot.set(r, stamp(s));
      if (entries.length >= limits.entries) {
        fail();
      }
      if (s.isSymbolicLink()) {
        // Preserve both direct target and final physical target; never enumerate an alias twice.
        const raw = fs.readlinkSync(p).replace(/^\\\\\?\\/, "");
        const target = relative(root, path.resolve(path.dirname(p), raw));
        const realpath = relative(root, fs.realpathSync.native(p));
        const resolved = stat(path.join(root, realpath));
        if (resolved.isSymbolicLink() || (!resolved.isDirectory() && !resolved.isFile())) {
          fail();
        }
        entries.push({
          path: r,
          kind: "link",
          target,
          realpath,
          targetKind: resolved.isDirectory() ? "directory" : "file",
        });
        snapshot.set(r, stamp(s) + ":" + target + ":" + realpath);
      } else if (s.isDirectory()) {
        entries.push({ path: r, kind: "directory" });
        walk(p, r, depth + 1);
      } else if (s.isFile()) {
        if (++files > limits.files || s.nlink !== 1n || s.size > BigInt(limits.fileBytes)) {
          fail();
        }
        total += Number(s.size);
        if (total > limits.totalBytes) {
          fail();
        }
        entries.push({
          path: r,
          kind: "file",
          size: Number(s.size),
          sha256: "",
        });
      } else {
        fail();
      }
    }
  }
  walk(root, "", 0);
  if (hashFiles) {
    hashInstallationFiles(root, entries, snapshot);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const physical = new Map(entries.map((e) => [e.path, e]));
  for (const e of entries) {
    if (e.kind === "link" && physical.get(e.realpath)?.kind !== e.targetKind) {
      fail();
    }
  }
  return { manifest: { version: 1, entries }, snapshot };
}
function equalSnapshots(a: Snapshot, b: Snapshot): boolean {
  return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}
function validate(value: unknown): asserts value is InstallationManifest {
  const object = (v: unknown, keys: string[]): Record<string, unknown> => {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).toSorted().join(",") !== keys.toSorted().join(",")
    ) {
      fail();
    }
    return v as Record<string, unknown>;
  };
  const m = object(value, ["version", "entries"]);
  if (
    m.version !== 1 ||
    !Array.isArray(m.entries) ||
    !m.entries.length ||
    m.entries.length > limits.entries
  ) {
    fail();
  }
  let previous = "",
    files = 0,
    total = 0;
  for (const item of m.entries) {
    const e = item as Record<string, unknown>;
    object(
      e,
      e?.kind === "file"
        ? ["path", "kind", "size", "sha256"]
        : e?.kind === "link"
          ? ["path", "kind", "target", "realpath", "targetKind"]
          : ["path", "kind"],
    );
    safePath(e.path);
    if (e.path <= previous) {
      fail();
    }
    previous = e.path;
    if (e.kind === "file") {
      if (
        typeof e.size !== "number" ||
        !Number.isSafeInteger(e.size) ||
        e.size < 0 ||
        e.size > limits.fileBytes ||
        typeof e.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(e.sha256) ||
        ++files > limits.files
      ) {
        fail();
      }
      total += e.size;
      if (total > limits.totalBytes) {
        fail();
      }
    } else if (e.kind === "link") {
      safePath(e.target);
      safePath(e.realpath);
      if (e.targetKind !== "file" && e.targetKind !== "directory") {
        fail();
      }
    } else if (e.kind !== "directory") {
      fail();
    }
  }
}

function boundaryPlan(
  root: string,
  manifest: InstallationManifest,
  baseline: Snapshot,
): BoundaryPlan {
  const children = new Map<string, string[]>([["", []]]);
  for (const entry of manifest.entries) {
    if (entry.kind === "directory") {
      children.set(entry.path, []);
    }
  }
  for (const entry of manifest.entries) {
    const at = entry.path.lastIndexOf("/");
    const parent = at < 0 ? "" : entry.path.slice(0, at);
    const name = at < 0 ? entry.path : entry.path.slice(at + 1);
    const names = children.get(parent);
    if (!names) {
      fail();
    }
    names.push(name);
  }
  for (const names of children.values()) {
    names.sort();
  }
  const planned = (rel: string) => {
    const expected = baseline.get(rel);
    if (expected === undefined) {
      fail();
    }
    return {
      file: path.join(root, rel),
      expected,
      names: children.get(rel),
    };
  };
  // Avoid parsing metadata strings: link stamps are captured separately below.
  const entries = [
    planned(""),
    ...manifest.entries.map((entry) => {
      const item = planned(entry.path);
      if (entry.kind !== "link") {
        return item;
      }
      const suffix = ":" + entry.target + ":" + entry.realpath;
      if (!item.expected.endsWith(suffix)) {
        fail();
      }
      return { ...item, expected: item.expected.slice(0, -suffix.length), target: entry.target };
    }),
  ];
  const ancestors = [...baseline].flatMap(([key, expected]) =>
    key.startsWith("absolute:") ? [{ file: key.slice(9), expected }] : [],
  );
  return { entries, ancestors };
}

/** Candidate generation is not registry or installed-mapping approval. */
export function inventoryInstallation(root: string): InstallationManifest {
  if (!path.isAbsolute(root)) {
    fail();
  }
  const before = scan(root, true);
  if (!equalSnapshots(before.snapshot, scan(root, false).snapshot)) {
    fail();
  }
  return before.manifest;
}
export function installationBuildHash(
  inventory: MaterialInventory,
  engineRevision: string,
  manifestHash: string,
): string {
  return evidenceHash({
    version: 2,
    contract: "legal-complete-installation-v1",
    engineRevision,
    files: inventory.files,
    installationManifestHash: manifestHash,
  });
}
export function createInstallationGuard(options: {
  installationRoot: string;
  installationManifestFile: string;
  installationManifestHash: string;
}): InstallationGuard {
  const {
    installationRoot: root,
    installationManifestFile: file,
    installationManifestHash: pin,
  } = options;
  if (!path.isAbsolute(root) || !path.isAbsolute(file) || !/^[0-9a-f]{64}$/.test(pin)) {
    fail();
  }
  // Mutable external contract/config files must not change the immutable measured root.
  const rel = path.relative(root, file);
  if (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)) {
    fail();
  }
  const bytes = readCheckedFile(file, limits.manifestBytes);
  if (bytesHash(bytes) !== pin) {
    fail();
  }
  const manifest = parseEvidenceJson(bytes, limits.manifestBytes);
  validate(manifest);
  const approved = evidenceHash(manifest);
  const physical = new Map(
    manifest.entries.filter((e) => e.kind === "file").map((e) => [e.path, e]),
  );
  let baseline: Snapshot | undefined,
    boundary: ReturnType<typeof createBoundaryVerifier> | undefined,
    failed = false;
  const held = <T>(action: () => T): T => {
    if (failed) {
      fail();
    }
    try {
      return action();
    } catch {
      failed = true;
      boundary?.dispose();
      return fail();
    }
  };
  const verify = () =>
    held(() => {
      if (bytesHash(readCheckedFile(file, limits.manifestBytes)) !== pin) {
        fail();
      }
      if (baseline && boundary) {
        // Every physical member and direct alias edge is checked twice against the
        // immutable bootstrap. Unchanged edges cannot resolve to a new final target
        // while their complete physical graph remains unchanged. Load hooks still
        // resolve the actual file and hash returned source; no age cache is used.
        boundary.verify();
        return;
      }
      const current = scan(root, true);
      if (
        evidenceHash(current.manifest) !== approved ||
        !equalSnapshots(current.snapshot, scan(root, false).snapshot)
      ) {
        fail();
      }
      baseline = current.snapshot;
      boundary = createBoundaryVerifier(root, boundaryPlan(root, manifest, baseline));
    });
  verify();
  return Object.freeze({
    root,
    manifestHash: pin,
    verify,
    refuse: () => held(fail),
    assertFile: (file: string) =>
      held(() => {
        const actual = fs.realpathSync.native(file),
          r = relative(root, actual),
          entry = physical.get(r);
        if (!entry || entry.kind !== "file") {
          fail();
        }
        const before = stat(actual);
        if (baseline?.get(r) !== stamp(before) || hashFile(actual, before) !== entry.sha256) {
          fail();
        }
        return entry.sha256;
      }),
  });
}
