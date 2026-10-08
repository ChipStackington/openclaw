import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { startGatewayServer } from "./server.impl.js";

test("actual gateway startup aborts invalid opted-in material before port or config side effects", async ({
  onTestFinished,
}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legal-gateway-startup-development-"));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, "startup.json");
  fs.writeFileSync(configFile, '{"version":1,"approved":true}');
  vi.stubEnv("OPENCLAW_LEGAL_EVIDENCE_STARTUP_FILE", configFile);
  vi.stubEnv("OPENCLAW_GATEWAY_PORT", "DEVELOPMENT-unchanged");
  await assert.rejects(startGatewayServer(0), /legal-evidence-startup-config/);
  assert.equal(process.env.OPENCLAW_GATEWAY_PORT, "DEVELOPMENT-unchanged");
});

test("actual gateway startup refuses an empty opt-in path", async () => {
  vi.stubEnv("OPENCLAW_LEGAL_EVIDENCE_STARTUP_FILE", "");
  await assert.rejects(startGatewayServer(0), /legal-evidence-startup-path/);
});
