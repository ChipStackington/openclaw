import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { test } from "vitest";
import { WebSocketServer } from "ws";

test("the narrow helper exits after its receipt while the server cannot finish a close handshake", async () => {
  // A real child and transport distinguish receipt time from process exit. The
  // fake server acknowledges once, then blocks like the guarded send boundary.
  const home = fs.mkdtempSync(path.join(process.cwd(), ".rpc-exit-fixture-"));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  let requests = 0;
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "offline-lifecycle-nonce", ts: Date.now() },
      }),
    );
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      if (request.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: request.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              server: { version: "offline", connId: request.id },
              features: { methods: ["agent"], events: ["tick"] },
              snapshot: {
                presence: [],
                health: {},
                stateVersion: { presence: 1, health: 1 },
                uptimeMs: 1,
              },
              policy: {
                maxPayload: 512 * 1024,
                maxBufferedBytes: 1024 * 1024,
                tickIntervalMs: 30000,
              },
            },
          }),
        );
      } else {
        requests++;
        socket.send(
          JSON.stringify({
            type: "res",
            id: request.id,
            ok: true,
            payload: { status: "accepted", runId: "offline-original" },
          }),
        );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
      }
    });
  });
  try {
    const helper = path.join(home, "helper.mjs"),
      receipt = path.join(home, "exit.json");
    await build({
      entryPoints: [path.resolve("src/gateway-rpc.ts")],
      outfile: helper,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      target: "node24",
    });
    fs.writeFileSync(
      path.join(home, "openclaw.json"),
      JSON.stringify({
        gateway: { mode: "local", port, auth: { mode: "token", token: "offline-lifecycle-token" } },
      }),
    );
    const bootstrap = `import fs from 'node:fs';const {callGatewayRpc}=await import(${JSON.stringify(pathToFileURL(helper).href)});const value=await callGatewayRpc('agent',{idempotencyKey:'offline-original'},5000);const resolvedAt=Date.now();process.once('exit',()=>fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({value,resolvedAt,exitAt:Date.now()})));`;
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        ["--input-type=module", "-e", bootstrap],
        {
          windowsHide: true,
          timeout: 15000,
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: home,
            OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
            NODE_OPTIONS: "--max-old-space-size=4096",
            NODE_DISABLE_COMPILE_CACHE: "1",
          },
        },
        (error, _stdout, stderr) => (error ? reject(new Error(String(error) + stderr)) : resolve()),
      );
    });
    const result = JSON.parse(fs.readFileSync(receipt, "utf8"));
    assert.deepEqual(result.value, { status: "accepted", runId: "offline-original" });
    assert.equal(requests, 1);
    assert.ok(
      result.exitAt - result.resolvedAt < 750,
      `helper held the receipt lease ${result.exitAt - result.resolvedAt}ms waiting for the server close handshake`,
    );
  } finally {
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 30000);
