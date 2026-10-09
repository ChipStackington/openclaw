import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

export type BoundaryPlan = Readonly<{
  ancestors: ReadonlyArray<{ file: string; expected: string }>;
  entries: ReadonlyArray<{
    file: string;
    expected: string;
    target?: string;
    names?: ReadonlyArray<string>;
  }>;
}>;

function fail(): never {
  throw new Error("legal-evidence-installation-drift");
}
function verifyBoundary(root: string, plan: BoundaryPlan): void {
  for (const { file, expected } of plan.ancestors) {
    const s = fs.lstatSync(file, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink() || [s.dev, s.ino, s.mode].join(":") !== expected) {
      fail();
    }
  }
  for (const { file, expected, target, names } of plan.entries) {
    const s = fs.lstatSync(file, { bigint: true });
    if ([s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":") !== expected) {
      fail();
    }
    if (names) {
      const actual = fs.readdirSync(file).toSorted();
      if (actual.length !== names.length || actual.some((name, i) => name !== names[i])) {
        fail();
      }
    }
    if (target !== undefined) {
      const raw = fs.readlinkSync(file).replace(/^\\\\\?\\/, "");
      const relative = path
        .relative(root, path.resolve(path.dirname(file), raw))
        .split(path.sep)
        .join("/");
      if (relative !== target) {
        fail();
      }
    }
  }
}

// These workers import only Node built-ins. Their private baseline is cloned once;
// every command still checks all assigned physical entries and alias edges twice.
// The second pass cannot start until all eight first passes have completed.
const boundaryWorker = String.raw`
const {workerData}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path');
const state=new Int32Array(workerData.state),slot=workerData.slot;
const stamp=s=>[s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
function verify(){
  for(const {file,expected} of workerData.ancestors){
    const s=fs.lstatSync(file,{bigint:true});
    if(!s.isDirectory()||s.isSymbolicLink()||[s.dev,s.ino,s.mode].join(':')!==expected)throw Error('drift');
  }
  for(const {file,expected,target,names} of workerData.entries){
    const s=fs.lstatSync(file,{bigint:true});if(stamp(s)!==expected)throw Error('drift');
    if(names){const actual=fs.readdirSync(file).sort();
      if(actual.length!==names.length||actual.some((name,i)=>name!==names[i]))throw Error('drift');}
    if(target!==undefined){const raw=fs.readlinkSync(file).replace(/^\\\\\?\\/,'');
      if(path.relative(workerData.root,path.resolve(path.dirname(file),raw)).split(path.sep).join('/')!==target)throw Error('drift');}
  }
}
try {
  let seen=0;
  for(;;){
    while(Atomics.load(state,8)===seen)Atomics.wait(state,8,seen,1000);
    seen=Atomics.load(state,8);verify();Atomics.store(state,slot,1);Atomics.notify(state,slot);
    for(;;){const phase=Atomics.load(state,9);if(phase===seen)break;Atomics.wait(state,9,phase,1000);}
    verify();Atomics.store(state,slot,2);Atomics.notify(state,slot);
  }
}catch{Atomics.store(state,slot,-1);Atomics.notify(state,slot);}
`;

export function createBoundaryVerifier(
  root: string,
  plan: BoundaryPlan,
): {
  verify: () => void;
  dispose: () => void;
} {
  if (plan.entries.length < 256) {
    return {
      verify: () => {
        verifyBoundary(root, plan);
        verifyBoundary(root, plan);
      },
      dispose: () => {},
    };
  }
  const stateBuffer = new SharedArrayBuffer(10 * 4),
    state = new Int32Array(stateBuffer);
  const workers: Worker[] = [];
  let generation = 0,
    disposed = false;
  const dispose = () => {
    disposed = true;
    for (const worker of workers) {
      void worker.terminate();
    }
  };
  try {
    for (let slot = 0; slot < 8; slot++) {
      const worker = new Worker(boundaryWorker, {
        eval: true,
        execArgv: [],
        workerData: {
          root,
          ancestors: plan.ancestors,
          entries: plan.entries.filter((_entry, index) => index % 8 === slot),
          state: stateBuffer,
          slot,
        },
      });
      worker.on("error", () => {});
      worker.unref();
      workers.push(worker);
    }
  } catch {
    dispose();
    fail();
  }
  return {
    dispose,
    verify: () => {
      if (disposed || generation === 2_147_483_647) {
        fail();
      }
      const started = Date.now();
      const waitFor = (expected: number) => {
        for (;;) {
          const values = [0, 1, 2, 3, 4, 5, 6, 7].map((slot) => Atomics.load(state, slot));
          if (values.some((value) => value < 0) || Date.now() - started >= 45_000) {
            dispose();
            fail();
          }
          const pending = values.findIndex((value) => value !== expected);
          if (pending < 0) {
            return;
          }
          Atomics.wait(state, pending, values[pending], 25);
        }
      };
      for (let slot = 0; slot < 8; slot++) {
        Atomics.store(state, slot, 0);
      }
      generation++;
      Atomics.store(state, 8, generation);
      Atomics.notify(state, 8);
      waitFor(1);
      Atomics.store(state, 9, generation);
      Atomics.notify(state, 9);
      waitFor(2);
    },
  };
}
