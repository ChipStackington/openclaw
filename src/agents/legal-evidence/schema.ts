import { evidenceJsonV1 } from "./hash.js";
import approvedSchema from "./schema.json" with { type: "json" };

type Schema = {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  not?: Schema;
  if?: Schema;
  then?: Schema;
  else?: Schema;
};
const definitions = approvedSchema.definitions as unknown as Record<string, Schema>;
const equal = (a: unknown, b: unknown) => evidenceJsonV1(a) === evidenceJsonV1(b);
function matches(s: Schema, value: unknown): boolean {
  if (s.$ref) {
    if (!s.$ref.startsWith("#/definitions/")) {
      throw new Error("evidence-schema-reference");
    }
    const ref = definitions[s.$ref.slice(14)];
    if (!ref) {
      throw new Error("evidence-schema-reference");
    }
    if (!matches(ref, value)) {
      return false;
    }
  }
  if (Object.hasOwn(s, "const") && !equal(s.const, value)) {
    return false;
  }
  if (s.enum && !s.enum.some((v) => equal(v, value))) {
    return false;
  }
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (
    types.length &&
    !types.some((t) =>
      t === "null"
        ? value === null
        : t === "array"
          ? Array.isArray(value)
          : t === "object"
            ? typeof value === "object" && value !== null && !Array.isArray(value)
            : t === "integer"
              ? typeof value === "number" && Number.isSafeInteger(value)
              : typeof value === t,
    )
  ) {
    return false;
  }
  if (
    typeof value === "number" &&
    (!Number.isSafeInteger(value) ||
      (s.minimum !== undefined && value < s.minimum) ||
      (s.maximum !== undefined && value > s.maximum))
  ) {
    return false;
  }
  if (typeof value === "string") {
    // JSON Schema counts Unicode code points, rather than grapheme clusters.
    const length = Array.from(value).length;
    if (
      (s.minLength !== undefined && length < s.minLength) ||
      (s.maxLength !== undefined && length > s.maxLength) ||
      (s.pattern && !new RegExp(s.pattern).test(value))
    ) {
      return false;
    }
    if (
      s.format === "date-time" &&
      (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    ) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    if (
      (s.minItems !== undefined && value.length < s.minItems) ||
      (s.maxItems !== undefined && value.length > s.maxItems) ||
      (s.items && !value.every((v) => matches(s.items!, v)))
    ) {
      return false;
    }
  } else if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    if (s.required?.some((k) => !Object.hasOwn(object, k))) {
      return false;
    }
    if (
      s.additionalProperties === false &&
      Object.keys(object).some((k) => !Object.hasOwn(s.properties ?? {}, k))
    ) {
      return false;
    }
    if (
      s.properties &&
      Object.entries(s.properties).some(
        ([k, child]) => Object.hasOwn(object, k) && !matches(child, object[k]),
      )
    ) {
      return false;
    }
  }
  if (s.allOf && !s.allOf.every((child) => matches(child, value))) {
    return false;
  }
  if (s.anyOf && !s.anyOf.some((child) => matches(child, value))) {
    return false;
  }
  if (s.oneOf && s.oneOf.filter((child) => matches(child, value)).length !== 1) {
    return false;
  }
  if (s.not && matches(s.not, value)) {
    return false;
  }
  if (s.if) {
    const branch = matches(s.if, value) ? s.then : s.else;
    if (branch && !matches(branch, value)) {
      return false;
    }
  }
  return true;
}

/** Implements only the Draft 7 vocabulary in the pinned schema; no schema is accepted from callers. */
export function assertEvidenceSchema(definition: string, value: unknown): void {
  evidenceJsonV1(value);
  if (!Object.hasOwn(definitions, definition) || !matches(definitions[definition], value)) {
    throw new Error("evidence-schema-invalid:" + definition);
  }
}
