import assert from "node:assert/strict";
import { test } from "vitest";
import fixtures from "./development-fixtures.json" with { type: "json" };
import { evidenceHash, evidenceJsonV1, parseEvidenceJson } from "./hash.js";
import { assertEvidenceSchema } from "./schema.js";

test("engine canonical hash is deterministic and arrays retain their order", () => {
  assert.equal(evidenceHash({ b: 2, a: [" é ", 1] }), evidenceHash({ a: [" é ", 1], b: 2 }));
  assert.notEqual(evidenceHash([1, 2]), evidenceHash([2, 1]));
  assert.equal(evidenceJsonV1({ z: 1, a: 2 }), '{"a":2,"z":1}');
});
for (const [index, value] of [
  undefined,
  Infinity,
  NaN,
  0.5,
  Number.MAX_SAFE_INTEGER + 1,
  new Date(),
  new Map(),
  { a: undefined },
].entries()) {
  test(`engine encoder rejects unsafe JSON value ${index}`, () =>
    assert.throws(() => evidenceJsonV1(value)));
}
for (const text of [
  '{"a":1,"a":2}',
  '{"a":1,"\\u0061":2}',
  '[{"a":1,"a":1}]',
  "1e999",
  "9007199254740992",
  "0.5",
]) {
  test(`engine parser refuses ambiguous ${text}`, () =>
    assert.throws(() => parseEvidenceJson(text)));
}
test("engine rejects malformed UTF-8, deep input and custom array prototypes", () => {
  assert.throws(() => parseEvidenceJson(Buffer.from([0x22, 0xff, 0x22])));
  assert.throws(() => parseEvidenceJson("[".repeat(101) + "0" + "]".repeat(101)));
  assert.throws(() => parseEvidenceJson('"' + String.fromCharCode(0xd800) + '"'));
  class UntrustedArray extends Array<number> {}
  assert.throws(() => evidenceJsonV1(new UntrustedArray(1)));
});
test("engine structural validation never certifies fixture provenance or hash consistency", () => {
  assertEvidenceSchema("EngineEnvelope", fixtures.records.engine);
  assertEvidenceSchema("ReviewedImplementationEnvelope", fixtures.records.reviewedImplementation);
  assert.throws(() =>
    assertEvidenceSchema("EngineEnvelope", { ...fixtures.records.engine, extra: true }),
  );
  assert.throws(() => assertEvidenceSchema("Time", "2026-02-30T00:00:00.000Z"));
});
