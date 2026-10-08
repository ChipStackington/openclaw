import { legalEvidenceAgentModuleUrl } from "../../gateway/server-methods/agent.js";
import {
  legalEvidenceAdapterModuleUrl,
  legalEvidenceExecutionModuleUrl,
} from "../pi-embedded-runner/run/attempt.js";
import { legalEvidenceCaptureModuleUrl } from "./capture.js";
import { legalEvidenceRuntimeModuleUrl } from "./runtime.js";
import { legalEvidenceStartupModuleUrl, readLegalEvidenceStartup } from "./startup.js";

/** Loaded only for explicitly configured startup; ordinary gateway startup retains its graph. */
export function createGatewayLegalEvidenceRuntime(options: {
  configFile: string;
  gatewayModuleUrl: string;
  readConfigFile: () => string | undefined;
  readAgents: () => unknown;
}) {
  return readLegalEvidenceStartup({
    ...options,
    engineModuleUrls: [
      options.gatewayModuleUrl,
      import.meta.url,
      legalEvidenceStartupModuleUrl,
      legalEvidenceRuntimeModuleUrl,
      legalEvidenceCaptureModuleUrl,
      legalEvidenceAgentModuleUrl,
      legalEvidenceExecutionModuleUrl,
    ],
    readAdapterModuleUrl: legalEvidenceAdapterModuleUrl,
  });
}
