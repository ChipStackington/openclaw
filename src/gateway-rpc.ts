// Stable, narrow entry point for local integrations. Reuse the normal gateway
// client so credential resolution, device proof, scopes and protocol stay shared.
import { readBestEffortConfig } from "./config/config.js";
import { callGateway } from "./gateway/call.js";
import { loadDotEnv } from "./infra/dotenv.js";
import { normalizeEnv } from "./infra/env.js";
import { assertSupportedRuntime } from "./infra/runtime-guard.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "./utils/message-channel.js";

export async function callGatewayRpc(
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  loadDotEnv({ quiet: true });
  normalizeEnv();
  assertSupportedRuntime();
  const config = await readBestEffortConfig();
  return callGateway({
    config,
    method,
    params,
    timeoutMs,
    expectFinal: false,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });
}
