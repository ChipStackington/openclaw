import { evidenceHash } from "./hash.js";
import manifest from "./policy.json" with { type: "json" };
import { assertEvidenceSchema } from "./schema.js";
import type { DispatchBinding, Expected, Role } from "./types.js";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const LEGAL_EVIDENCE_POLICY = freeze(manifest);
export const LEGAL_EVIDENCE_MODEL_POLICY_HASH = evidenceHash(LEGAL_EVIDENCE_POLICY);
export function legalEvidenceExpected(role: Role): Expected {
  if (!Object.hasOwn(LEGAL_EVIDENCE_POLICY.roles, role)) {
    throw new Error("evidence-policy-role");
  }
  const expected = structuredClone(LEGAL_EVIDENCE_POLICY.roles[role]) as Expected;
  assertEvidenceSchema("Expected", expected);
  return expected;
}
export function assertLegalEvidencePolicy(binding: DispatchBinding): void {
  if (
    binding.modelPolicyHash !== LEGAL_EVIDENCE_MODEL_POLICY_HASH ||
    evidenceHash(binding.expected) !== evidenceHash(legalEvidenceExpected(binding.roleId))
  ) {
    throw new Error("evidence-policy-mismatch");
  }
}
