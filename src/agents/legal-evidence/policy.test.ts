import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { bytesHash, evidenceHash } from "./hash.js";
import {
  LEGAL_EVIDENCE_POLICY,
  LEGAL_EVIDENCE_MODEL_POLICY_HASH,
  legalEvidenceExpected,
} from "./policy.js";

test("engine strict manifest pins exact loaded schema bytes and every legal role", () => {
  assert.equal(
    bytesHash(fs.readFileSync(path.join(process.cwd(), "src/agents/legal-evidence/schema.json"))),
    LEGAL_EVIDENCE_POLICY.schemaBytesHash,
  );
  const roles = Object.keys(LEGAL_EVIDENCE_POLICY.roles) as Array<
    keyof typeof LEGAL_EVIDENCE_POLICY.roles
  >;
  assert.equal(roles.length, 7);
  for (const role of roles) {
    const astra = ["legal-verification", "legal-strategy"].includes(role);
    assert.deepEqual(legalEvidenceExpected(role), {
      provider: "openai-codex",
      model: astra ? "gpt-6-astra" : "gpt-6.1-sol",
      effort: astra ? "medium" : "high",
      physicalRequestCeiling: 1,
    });
  }
});
test("engine policy hash binds every cap and forbidden execution path", () => {
  for (const key of Object.keys(LEGAL_EVIDENCE_POLICY.limits) as Array<
    keyof typeof LEGAL_EVIDENCE_POLICY.limits
  >) {
    const changed = structuredClone(LEGAL_EVIDENCE_POLICY);
    changed.limits[key]++;
    assert.notEqual(evidenceHash(changed), LEGAL_EVIDENCE_MODEL_POLICY_HASH);
  }
  assert.notEqual(
    evidenceHash({ ...LEGAL_EVIDENCE_POLICY, forbidden: [] }),
    LEGAL_EVIDENCE_MODEL_POLICY_HASH,
  );
  assert.throws(() => {
    LEGAL_EVIDENCE_POLICY.roles["legal-facts"].model = "changed";
  });
});
