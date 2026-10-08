import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkedDirectory, readCheckedFile } from "./files.js";
import { bytesHash, evidenceHash, parseEvidenceJson } from "./hash.js";
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
function scan(
  root: string,
  hashFiles: boolean,
): { manifest: InstallationManifest; snapshot: Snapshot } {
  checkedDirectory(root);
  const entries: Entry[] = [],
    snapshot: Snapshot = new Map();
  const buffer = hashFiles ? Buffer.allocUnsafe(1_048_576) : undefined;
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
          sha256: hashFiles ? hashFile(p, s, buffer) : "",
        });
      } else {
        fail();
      }
    }
  }
  walk(root, "", 0);
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
    failed = false;
  const held = <T>(action: () => T): T => {
    if (failed) {
      fail();
    }
    try {
      return action();
    } catch {
      failed = true;
      return fail();
    }
  };
  const verify = () =>
    held(() => {
      if (bytesHash(readCheckedFile(file, limits.manifestBytes)) !== pin) {
        fail();
      }
      const current = scan(root, true);
      if (
        evidenceHash(current.manifest) !== approved ||
        !equalSnapshots(current.snapshot, scan(root, false).snapshot) ||
        (baseline && !equalSnapshots(baseline, current.snapshot))
      ) {
        fail();
      }
      baseline ??= current.snapshot;
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
