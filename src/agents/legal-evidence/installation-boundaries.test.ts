import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { test } from "vitest";
import fixtures from "./development-fixtures.json" with { type: "json" };
import { bytesHash, evidenceHash } from "./hash.js";
import { installationBuildHash, inventoryInstallation } from "./installation.js";
import { materialInventoryHash, type MaterialInventory } from "./material.js";
import type { RuntimeIdentity } from "./types.js";

const agents = { defaults: { model: { primary: "DEVELOPMENT", fallbacks: [] } } };
const main = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readLegalEvidenceStartup, getLegalEvidenceCapabilities, getLegalEvidenceOperation, resolveEvidenceClientBinding,
  LegalEvidenceCapture, EngineEvidenceStore, bytesHash, evidenceHash} from './dist/probe-api.js';
const file=process.env.OPENCLAW_LEGAL_EVIDENCE_STARTUP_FILE;
const config=JSON.parse(fs.readFileSync(file));
const read=readLegalEvidenceStartup({configFile:file,engineModuleUrls:[new URL('./dist/probe-api.js',import.meta.url).href],
 readAdapterModuleUrl:()=>new URL('./adapter/dist/index.js',import.meta.url).href,
 readAgents:()=>({defaults:{model:{primary:'DEVELOPMENT',fallbacks:[]}}})});
assert.deepEqual(getLegalEvidenceCapabilities(read).runtime,config.expected);
const store=new EngineEvidenceStore(process.env.PROBE_STATE);
const record=JSON.parse(fs.readFileSync(process.env.PROBE_RECORD));
const peer={authenticatedDeviceId:record.client.deviceId,clientId:'development-cli',clientRole:'operator',clientMode:'cli',scopes:['operator.read','operator.write'],isWebchat:false};
record.client=resolveEvidenceClientBinding(peer,'operator.write');
record.operationId=randomUUID(); record.binding.operationId=record.operationId;
record.preparedAt=new Date().toISOString(); record.binding.deadlineAt=new Date(Date.now()+60000).toISOString();
record.runtime=config.expected; record.binding.submittedPromptHash=bytesHash('offline');
for(const [key,value] of Object.entries(config.expected)){
 const mapping={installationId:'engineInstallationId',engineRevision:'engineRevision',engineBuildHash:'engineBuildHash',
 adapterVersion:'engineAdapterVersion',adapterPatchHash:'engineAdapterPatchHash',adapterContentHash:'engineAdapterContentHash',rolePolicyHash:'engineRolePolicyHash'};
 record.binding[mapping[key]]=value;
}
record.bindingHash=evidenceHash(record.binding); record.state='prepared';record.events=[];record.attempts=[];
record.journal=store.putBlob('journal',Buffer.from('[]'));
for(const key of ['endedAt','selectedAttemptId','executionSummary','holdReason'])delete record[key];
const capture=LegalEvidenceCapture.create(store,record,'offline',read);
capture.candidate('openai-codex','gpt-6.1-sol','high');capture.runnerStarted();
const request={body:JSON.stringify({model:'gpt-6.1-sol',reasoning:{effort:'high'},stream:true,
 input:[{role:'user',content:[{type:'input_text',text:'offline'}]}]}),url:'https://chatgpt.com/backend-api/codex/responses',
 method:'POST',transport:'sse',model:'gpt-6.1-sol',provider:'openai-codex',httpAttemptIndex:0};
let providerCalls=0;globalThis.fetch=()=>{providerCalls++;throw Error('provider must remain offline');};
const mutation=process.env.PROBE_MUTATION,boundary=process.env.PROBE_BOUNDARY;
const dependency=new URL(mutation==='lazy'?'./node_modules/openai/lazy.js':mutation==='native'?'./native.node':'./node_modules/undici/index.js',import.meta.url);
const mutate=()=>{
 if(mutation==='alias'){
  const alias=new URL('./network-alias',import.meta.url);fs.unlinkSync(alias);
  fs.symlinkSync(path.dirname(new URL('./node_modules/openai/lazy.js',import.meta.url).pathname.replace(/^\\/(\\w:)/,'$1')),
   alias,process.platform==='win32'?'junction':'dir');
 }else fs.appendFileSync(dependency,' harmless changed bytes');
};
if(boundary==='send'){
 mutate();await assert.rejects(()=>capture.observer.onRequest(request));
 assert.equal(store.read(record.operationId).record.attempts.length,0);
}else{
 await capture.observer.onRequest(request);await capture.observer.onResponse({status:200,contentType:'text/event-stream'});
 const text='{"offline":true}',frame=Buffer.from('data: '+JSON.stringify({type:'response.completed',response:{id:'resp_offline',
 model:'gpt-6.1-sol',status:'completed',reasoning:{effort:'high'},output:[{type:'message',role:'assistant',status:'completed',
 content:[{type:'output_text',text}]}]}})+'\\r\\n\\r\\n');
 await capture.observer.onChunk(frame);await capture.observer.onTerminal(frame);
 await capture.observer.onComplete({text,stopReason:'stop',toolCalls:0});mutate();
 assert.throws(()=>capture.finishRunner({aborted:false,compactions:0,toolCalls:0,messagingSends:0,
 continuations:0,thinkingDowngrades:0,authRotations:0}));
 assert.equal(store.read(record.operationId).record.attempts.length,1);
 assert.notEqual(store.read(record.operationId).record.state,'completed');
}
assert.equal(getLegalEvidenceCapabilities(read),undefined);
assert.equal(providerCalls,0);
assert.throws(()=>LegalEvidenceCapture.create(store,record,'offline',()=>config.expected));
const snapshot=()=>{
 const walk=(dir)=>fs.readdirSync(dir).flatMap(name=>{const f=path.join(dir,name);
 return fs.lstatSync(f).isDirectory()?walk(f):[[f,bytesHash(fs.readFileSync(f))]];});return walk(store.root);
};
const before=snapshot();
const recovered=getLegalEvidenceOperation({store:new EngineEvidenceStore(store.root),operationId:record.operationId,peer});
assert.notEqual(recovered.state,'completed');assert.deepEqual(snapshot(),before);
console.log(JSON.stringify({compiledStartup:true,capabilityHeld:true,boundary,mutation,providerCalls,
 permanentReservation:true,readOnlyRecovery:true,attempts:store.read(record.operationId).record.attempts.length}));`;

for (const [boundary, mutation] of [
  ["send", "network"],
  ["send", "lazy"],
  ["send", "alias"],
  ["seal", "native"],
  ["seal", "lazy"],
]) {
  test(`compiled startup/capability/${boundary} holds ${mutation} drift without refund or recovery writes`, ({
    onTestFinished,
  }) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "legal-compiled-boundaries-"));
    onTestFinished(() => fs.rmSync(temp, { recursive: true, force: true }));
    const root = path.join(temp, "immutable"),
      dist = path.join(root, "dist"),
      adapter = path.join(root, "adapter");
    fs.mkdirSync(dist, { recursive: true });
    fs.mkdirSync(path.join(adapter, "dist/providers"), { recursive: true });
    const source = path.dirname(fileURLToPath(import.meta.url));
    buildSync({
      stdin: {
        contents: `export {readLegalEvidenceStartup} from './startup.ts';
      export {getLegalEvidenceCapabilities,getLegalEvidenceOperation,resolveEvidenceClientBinding} from './gateway.ts';
      export {LegalEvidenceCapture} from './capture.ts';export {EngineEvidenceStore} from './store.ts';
      export {bytesHash,evidenceHash} from './hash.ts';`,
        resolveDir: source,
      },
      outfile: path.join(dist, "probe-api.js"),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
    });
    const preload = path.join(root, "preload.js");
    buildSync({
      entryPoints: [path.join(source, "preload.ts")],
      outfile: preload,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
    });
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(
      path.join(adapter, "package.json"),
      JSON.stringify({ name: "@mariozechner/pi-ai", version: "0.57.1" }),
    );
    for (const name of [
      "index.js",
      "providers/openai-codex-responses.js",
      "providers/legal-evidence-sse.js",
    ]) {
      fs.writeFileSync(path.join(adapter, "dist", name), "// DEVELOPMENT adapter fixture");
    }
    for (const name of [
      "node_modules/undici/index.js",
      "node_modules/openai/lazy.js",
      "native.node",
    ]) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "DEVELOPMENT dependency");
    }
    fs.symlinkSync(
      path.join(root, "node_modules/undici"),
      path.join(root, "network-alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const entry = path.join(root, "main.js");
    fs.writeFileSync(entry, main);
    const patchFile = path.join(root, "adapter.patch");
    fs.writeFileSync(patchFile, "DEVELOPMENT patch");
    const inventory = (dir: string, relative = ""): MaterialInventory => ({
      version: 1,
      files: fs
        .readdirSync(dir)
        .flatMap((name) => {
          const file = path.join(dir, name),
            rel = relative ? relative + "/" + name : name;
          return fs.lstatSync(file).isDirectory()
            ? inventory(file, rel).files
            : [{ path: rel, sha256: bytesHash(fs.readFileSync(file)) }];
        })
        .toSorted((a, b) => (a.path < b.path ? -1 : 1)),
    });
    const engineInventory = inventory(dist),
      adapterInventory = inventory(adapter);
    const installationManifestFile = path.join(temp, "manifest.json");
    fs.writeFileSync(installationManifestFile, JSON.stringify(inventoryInstallation(root)));
    const installationManifestHash = bytesHash(fs.readFileSync(installationManifestFile));
    const expected = structuredClone(fixtures.records.engine.record.runtime) as RuntimeIdentity;
    expected.engineBuildHash = installationBuildHash(
      engineInventory,
      expected.engineRevision,
      installationManifestHash,
    );
    expected.adapterContentHash = materialInventoryHash(adapterInventory, {
      package: "@mariozechner/pi-ai",
      packageVersion: "0.57.1",
    });
    expected.adapterPatchHash = bytesHash(fs.readFileSync(patchFile));
    expected.rolePolicyHash = evidenceHash({ version: 1, agents });
    const installationFile = path.join(temp, "installation.json");
    fs.writeFileSync(
      installationFile,
      JSON.stringify({ version: 1, installationId: expected.installationId }),
    );
    const configFile = path.join(temp, "startup.json"),
      recordFile = path.join(temp, "record.json");
    fs.writeFileSync(recordFile, JSON.stringify(fixtures.records.engine.record));
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        version: 2,
        expected,
        engineRoot: dist,
        engineInventory,
        adapterRoot: adapter,
        adapterInventory,
        patchFile,
        installationFile,
        installationRoot: root,
        installationManifestFile,
        installationManifestHash,
      }),
    );
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, entry], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_LEGAL_EVIDENCE_STARTUP_FILE: configFile,
        PROBE_RECORD: recordFile,
        PROBE_STATE: path.join(temp, "state"),
        PROBE_MUTATION: mutation,
        PROBE_BOUNDARY: boundary,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"providerCalls":0/);
    assert.match(result.stdout, /"readOnlyRecovery":true/);
  });
}
