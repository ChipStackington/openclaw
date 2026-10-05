import path from "node:path";
import {
  getLegalEvidenceCapabilities,
  getLegalEvidenceOperation,
  readLegalEvidenceBlob,
  resolveEvidenceClientBinding,
  type EvidencePeer,
} from "../../agents/legal-evidence/gateway.js";
import { assertEvidenceSchema } from "../../agents/legal-evidence/schema.js";
import { EngineEvidenceStore } from "../../agents/legal-evidence/store.js";
import { resolveStateDir } from "../../config/paths.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";

function evidenceStore(): EngineEvidenceStore {
  return new EngineEvidenceStore(path.join(resolveStateDir(), "quinn-legal-evidence-v1"));
}

function peerFromClient(client: GatewayClient | null, isWebchat: boolean): EvidencePeer {
  return {
    authenticatedDeviceId: client?.authenticatedDeviceId,
    clientId: client?.connect.client.id ?? "",
    clientRole: client?.connect.role ?? "",
    clientMode: client?.connect.client.mode ?? "",
    scopes: client?.connect.scopes ?? [],
    isWebchat,
  };
}

function sendFailure(respond: RespondFn, error: unknown) {
  const message = error instanceof Error ? error.message : "legal-evidence-unavailable";
  const denied = message === "legal-evidence-client-denied";
  respond(
    false,
    undefined,
    errorShape(
      denied ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
      denied ? message : "legal-evidence-unavailable",
    ),
  );
}

export const legalEvidenceHandlers: GatewayRequestHandlers = {
  "agent.evidence.capabilities": ({ params, client, isWebchatConnect, respond, context }) => {
    try {
      assertEvidenceSchema("EvidenceCapabilityParams", params);
      const peer = peerFromClient(
        client,
        client?.connect ? isWebchatConnect(client.connect) : true,
      );
      resolveEvidenceClientBinding(peer, "operator.read");
      const capabilities = getLegalEvidenceCapabilities(context.legalEvidenceRuntime);
      if (!capabilities) {
        throw new Error("legal-evidence-runtime-unavailable");
      }
      assertEvidenceSchema("Capabilities", capabilities);
      respond(true, capabilities);
    } catch (error) {
      sendFailure(respond, error);
    }
  },
  "agent.evidence.get": ({ params, client, isWebchatConnect, respond, context }) => {
    try {
      assertEvidenceSchema("EvidenceGetParams", params);
      const peer = peerFromClient(
        client,
        client?.connect ? isWebchatConnect(client.connect) : true,
      );
      const result = getLegalEvidenceOperation({
        store: evidenceStore(),
        operationId: typeof params.operationId === "string" ? params.operationId : "",
        peer,
        activeOperationIds: context.legalEvidenceActiveOperationIds,
      });
      assertEvidenceSchema("EvidenceGetResult", result);
      respond(true, result);
    } catch (error) {
      sendFailure(respond, error);
    }
  },
  "agent.evidence.read": ({ params, client, isWebchatConnect, respond }) => {
    try {
      assertEvidenceSchema("EvidenceReadParams", params);
      const peer = peerFromClient(
        client,
        client?.connect ? isWebchatConnect(client.connect) : true,
      );
      const result = readLegalEvidenceBlob({
        store: evidenceStore(),
        operationId: typeof params.operationId === "string" ? params.operationId : "",
        blobHash: typeof params.blobHash === "string" ? params.blobHash : "",
        offset: params.offset as number,
        length: params.length as number,
        peer,
      });
      assertEvidenceSchema("EvidenceReadResult", result);
      respond(true, result);
    } catch (error) {
      sendFailure(respond, error);
    }
  },
};
