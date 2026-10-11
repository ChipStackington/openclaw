import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
import { createBoundaryVerifier } from "./installation-boundary.js";

const control = vi.hoisted(() => ({ mode: "delay", probe: new SharedArrayBuffer(16 * 4) }));
vi.mock("node:worker_threads", async () => {
  const real = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
  return {
    ...real,
    Worker: class extends real.Worker {
      constructor(code: string | URL, options: import("node:worker_threads").WorkerOptions = {}) {
        let script = String(code);
        if (control.mode === "exit" && options.workerData.slot === 0) {
          script = "process.exit(0)";
        } else {
          script = script.replace(
            "seen=Atomics.load(state,8);verify();",
            `seen=Atomics.load(state,8);
          if(slot===7)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);
          verify();Atomics.add(new Int32Array(workerData.probe),slot,1);`,
          );
          script = script.replace(
            "verify();Atomics.store(state,slot,2);",
            `
          if(Array.from(new Int32Array(workerData.probe).subarray(0,8)).some(x=>x!==seen))throw Error('barrier');
          verify();Atomics.add(new Int32Array(workerData.probe),slot+8,1);Atomics.store(state,slot,2);`,
          );
        }
        super(script, { ...options, workerData: { ...options.workerData, probe: control.probe } });
      }
    },
  };
});
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});
function fixture(mode = "delay") {
  control.mode = mode;
  new Int32Array(control.probe).fill(0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legal-async-boundary-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "file");
  fs.writeFileSync(file, "original");
  const s = fs.lstatSync(file, { bigint: true });
  const expected = [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
  const v = createBoundaryVerifier(root, {
    ancestors: [],
    entries: Array.from({ length: 256 }, () => ({ file, expected })),
  });
  cleanups.push(v.dispose);
  return { v, file };
}
test("slow integrity checks allow timers and serialize complete fresh generations", async () => {
  const { v } = fixture();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  cleanups.push(() => clearInterval(timer));
  await Promise.all([v.verifyAsync(), v.verifyAsync()]);
  assert.ok(ticks > 3, "gateway timers must run while workers scan");
  assert.deepEqual(Array.from(new Int32Array(control.probe)), Array(16).fill(2));
});
test("a later boundary cannot reuse a completed scan, and refusal is permanent", async () => {
  const { v, file } = fixture();
  await v.verifyAsync();
  fs.writeFileSync(file, "changed!");
  await assert.rejects(v.verifyAsync(), /installation-drift/);
  fs.writeFileSync(file, "original");
  await assert.rejects(v.verifyAsync(), /installation-drift/);
  assert.throws(v.verify, /installation-drift/);
});
test("disposing an active generation rejects it and every queued boundary", async () => {
  const { v } = fixture();
  const results = Promise.allSettled([v.verifyAsync(), v.verifyAsync()]);
  setTimeout(v.dispose, 20);
  assert.ok((await results).every((result) => result.status === "rejected"));
  await assert.rejects(v.verifyAsync(), /installation-drift/);
});

test("a worker that exits refuses active and queued asynchronous boundaries", async () => {
  const { v } = fixture("exit");
  const results = await Promise.allSettled([v.verifyAsync(), v.verifyAsync()]);
  assert.ok(results.every((result) => result.status === "rejected"));
  await assert.rejects(v.verifyAsync(), /installation-drift/);
});
test("synchronous reentry cannot reset a pending asynchronous generation", async () => {
  const { v } = fixture();
  const pending = v.verifyAsync();
  assert.throws(v.verify, /installation-drift/);
  await assert.rejects(pending, /installation-drift/);
});
test("queued boundaries retain the existing deadline and sticky failure", async () => {
  const { v } = fixture();
  const results = Promise.allSettled([v.verifyAsync(), v.verifyAsync()]);
  const actualNow = Date.now;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => actualNow() + 46_000);
  try {
    assert.ok((await results).every((result) => result.status === "rejected"));
  } finally {
    clock.mockRestore();
  }
  await assert.rejects(v.verifyAsync(), /installation-drift/);
});
