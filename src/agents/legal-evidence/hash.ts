import { createHash } from "node:crypto";

/** This encoding is separate from the existing legal team's teamHash contract. */
export function evidenceJsonV1(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(v: unknown, depth: number): string {
    if (depth > 100) {
      throw new Error("evidence-json-depth");
    }
    if (v === null || typeof v === "string" || typeof v === "boolean") {
      return JSON.stringify(v);
    }
    if (typeof v === "number" && Number.isSafeInteger(v)) {
      return JSON.stringify(v);
    }
    if (typeof v !== "object" || v === null || ancestors.has(v)) {
      throw new Error("evidence-json-value");
    }
    const proto = Object.getPrototypeOf(v);
    if (
      Array.isArray(v) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null
    ) {
      throw new Error("evidence-json-prototype");
    }
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (
      Object.getOwnPropertySymbols(v).length ||
      Object.entries(descriptors).some(
        ([key, d]) => !(Array.isArray(v) && key === "length") && (!d.enumerable || !("value" in d)),
      )
    ) {
      throw new Error("evidence-json-properties");
    }
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.keys(v).length !== v.length ||
          Object.keys(v).some((key, i) => key !== String(i))
        ) {
          throw new Error("evidence-json-array");
        }
        return "[" + v.map((x) => encode(x, depth + 1)).join(",") + "]";
      }
      return (
        "{" +
        Object.keys(v)
          .toSorted()
          .map((k) => JSON.stringify(k) + ":" + encode(descriptors[k].value, depth + 1))
          .join(",") +
        "}"
      );
    } finally {
      ancestors.delete(v);
    }
  }
  return encode(value, 0);
}
export const evidenceHash = (value: unknown): string =>
  createHash("sha256").update(evidenceJsonV1(value)).digest("hex");
export const bytesHash = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

/** JSON.parse alone discards duplicate keys and repairs malformed UTF-8. */
export function parseEvidenceJson(value: Uint8Array | string, maxBytes = 128_000): unknown {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || bytes.byteLength > maxBytes) {
    throw new Error("evidence-json-limit");
  }
  const input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (typeof value === "string" && input !== value) {
    throw new Error("evidence-json-utf8-loss");
  }
  let offset = 0;
  const space = () => {
    while (/^[\t\r\n ]$/.test(input[offset] ?? "")) {
      offset++;
    }
  };
  function string(): string {
    if (input[offset] !== '"') {
      throw new Error("evidence-json-string");
    }
    const start = offset++;
    while (offset < input.length) {
      if (input[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (input[offset++] === '"') {
        return JSON.parse(input.slice(start, offset));
      }
    }
    throw new Error("evidence-json-string");
  }
  function scan(depth: number): void {
    if (depth > 100) {
      throw new Error("evidence-json-depth");
    }
    space();
    const ch = input[offset];
    if (ch === '"') {
      string();
      return;
    }
    if (ch === "{" || ch === "[") {
      offset++;
      space();
      const end = ch === "{" ? "}" : "]",
        keys = new Set<string>();
      if (input[offset] === end) {
        offset++;
        return;
      }
      while (offset < input.length) {
        if (ch === "{") {
          const key = string();
          if (keys.has(key)) {
            throw new Error("evidence-json-duplicate-key");
          }
          keys.add(key);
          space();
          if (input[offset++] !== ":") {
            throw new Error("evidence-json-colon");
          }
        }
        scan(depth + 1);
        space();
        const separator = input[offset++];
        if (separator === end) {
          return;
        }
        if (separator !== ",") {
          throw new Error("evidence-json-separator");
        }
        space();
      }
      throw new Error("evidence-json-unclosed");
    }
    const atom = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      input.slice(offset),
    );
    if (!atom) {
      throw new Error("evidence-json-atom");
    }
    offset += atom[0].length;
  }
  scan(0);
  space();
  if (offset !== input.length) {
    throw new Error("evidence-json-trailing");
  }
  const result: unknown = JSON.parse(input);
  evidenceJsonV1(result);
  return result;
}
