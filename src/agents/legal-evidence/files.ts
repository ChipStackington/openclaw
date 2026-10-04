import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const same = (a: fs.Stats, b: fs.Stats) =>
  a.ino === b.ino &&
  a.dev === b.dev &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const ancestors = (file: string) => {
  const result: string[] = [];
  let current = path.resolve(file);
  for (;;) {
    result.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return result;
    }
    current = parent;
  }
};

/** Check every ancestor before creation; a junction above the chosen root is also unsafe. */
export function checkedDirectory(directory: string, create = false): void {
  for (const component of ancestors(directory)) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(component);
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      fs.mkdirSync(component, { mode: 0o700 });
      stat = fs.lstatSync(component);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("evidence-directory-unsafe");
    }
  }
}

export function readCheckedFile(file: string, maxBytes: number): Buffer {
  const directory = path.dirname(file);
  checkedDirectory(directory);
  const directories = ancestors(directory).map((p) => ({ p, stat: fs.lstatSync(p) }));
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error("evidence-file-unsafe");
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const opened = fs.fstatSync(fd);
    if (!same(before, opened) || opened.nlink !== 1) {
      throw new Error("evidence-file-changed");
    }
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!n) {
        break;
      }
      length += n;
    }
    const after = fs.fstatSync(fd),
      named = fs.lstatSync(file);
    if (
      length !== opened.size ||
      !same(opened, after) ||
      !same(after, named) ||
      after.nlink !== 1 ||
      named.isSymbolicLink()
    ) {
      throw new Error("evidence-file-changed");
    }
    for (const { p, stat } of directories) {
      const now = fs.lstatSync(p);
      if (now.isSymbolicLink() || now.ino !== stat.ino || now.dev !== stat.dev) {
        throw new Error("evidence-directory-changed");
      }
    }
    return bytes.subarray(0, length);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** Only absence of the record itself frees a namespace slot. Missing referenced material never does. */
export function evidenceFileExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function flushDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows does not expose portable directory fsync. Reboot/power-loss acceptance stays separate.
    if (
      process.platform !== "win32" ||
      !["EPERM", "EACCES", "EISDIR", "EBADF", "EINVAL"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** Caller holds its namespace/key lock and has verified any existing destination. */
export function writeEvidenceFile(file: string, bytes: Uint8Array): void {
  checkedDirectory(path.dirname(file));
  const temporary = file + "." + randomUUID() + ".tmp";
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    checkedDirectory(path.dirname(file));
    fs.renameSync(temporary, file);
    flushDirectory(path.dirname(file));
    if (!readCheckedFile(file, bytes.byteLength).equals(Buffer.from(bytes))) {
      throw new Error("evidence-write-readback");
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
    if (fs.existsSync(temporary)) {
      fs.unlinkSync(temporary);
    }
  }
}

export function withEvidenceLock<T>(file: string, action: () => T): T {
  checkedDirectory(path.dirname(file));
  // A process crash leaves this exclusive reservation visible; never steal it based on age.
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, String(process.pid));
    fs.fsyncSync(fd);
    return action();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(file);
  }
}
