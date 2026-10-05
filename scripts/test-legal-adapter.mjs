import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { pathToFileURL } from "node:url";
const test = (name, fn) => {
  void nodeTest(name, fn);
};
const root = process.env.B2_ADAPTER_ROOT;
assert.ok(root, "B2_ADAPTER_ROOT must identify a physical offline test package");
assert.equal(
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
  "0.57.1",
  "the adapter test must use the pinned pi-ai package",
);
assert.ok(
  fs.existsSync(path.join(root, "dist/providers/legal-evidence-sse.js")),
  "the installed package is missing the tracked legal SSE patch",
);
const { streamSimpleOpenAICodexResponses: stream } = await import(
  pathToFileURL(path.join(root, "dist/providers/openai-codex-responses.js"))
);
const model = {
  id: "gpt-6.1-sol",
  name: "development",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 32000,
};
const key =
  "x." +
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } }),
  ).toString("base64url") +
  ".x";
const context = { messages: [{ role: "user", content: "offline", timestamp: 0 }] };
const text = '{"ok":"\u00e9 \ud83d\ude80"}';
const item = {
  id: "msg_offline",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
};
const terminal = {
  type: "response.completed",
  response: {
    id: "resp_offline",
    model: model.id,
    status: "completed",
    output: [item],
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
  },
};
const encode = (e, newline = "\n") => Buffer.from("data: " + JSON.stringify(e) + newline + newline);
const frames = [
  { type: "response.output_item.added", item: { ...item, content: [] } },
  { type: "response.content_part.added", part: { type: "output_text", text: "", annotations: [] } },
  { type: "response.output_text.delta", delta: text },
  { type: "response.output_item.done", item },
  terminal,
];
const wire = Buffer.concat(frames.map((e) => encode(e)));
function observer() {
  const seen = { requests: [], bytes: [], terminals: [], complete: [], failures: [], retry: [] };
  return {
    seen,
    onRequest: async (r) => seen.requests.push(r),
    onResponse: async (r) => {
      seen.response = r;
    },
    onChunk: async (b) => seen.bytes.push(Buffer.from(b)),
    onTerminal: async (b) => seen.terminals.push(Buffer.from(b)),
    onComplete: async (r) => seen.complete.push(r),
    onFailure: async (r) => seen.failures.push(r),
    onRetryDenied: async () => seen.retry.push(true),
  };
}
function response(bytes = wire, status = 200, chunks = [bytes]) {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const b of chunks) {
          c.enqueue(b);
        }
        c.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream" } },
  );
}
async function run(fetchFn, options = {}) {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls++;
    return fetchFn(...args);
  };
  try {
    return {
      result: await stream(model, context, { apiKey: key, reasoning: "high", ...options }).result(),
      calls,
    };
  } finally {
    globalThis.fetch = original;
  }
}
test("observer forwarded after awaited payload mutation and final serialization", async () => {
  const o = observer();
  let actual;
  const r = await run(
    async (url, init) => {
      actual = init;
      return response();
    },
    {
      legalEvidenceObserver: o,
      onPayload: async (body) => {
        await Promise.resolve();
        return { ...body, extra: "mutated" };
      },
    },
  );
  assert.equal(r.result.stopReason, "stop");
  assert.equal(o.seen.requests.length, 1);
  assert.equal(o.seen.requests[0].body, actual.body);
  assert.equal(JSON.parse(actual.body).extra, "mutated");
  assert.equal(actual.redirect, "manual");
  assert.deepEqual(Buffer.concat(o.seen.bytes), wire);
  assert.deepEqual(o.seen.terminals, [encode(terminal)]);
  assert.equal(o.seen.complete[0].text, text);
});
for (const kind of ["429", "network", "redirect"]) {
  test(`strict ${kind} has one fetch and no retry`, async () => {
    const o = observer();
    const r = await run(
      async () => {
        if (kind === "network") {
          throw Error("offline transport");
        }
        return response(Buffer.from("offline"), kind === "429" ? 429 : 302);
      },
      { legalEvidenceObserver: o },
    );
    assert.equal(r.calls, 1);
    assert.equal(r.result.stopReason, "error");
    assert.equal(o.seen.requests.length, 1);
    assert.equal(o.seen.failures.length, 1);
    assert.equal(o.seen.retry.length, 1);
  });
}
test("request capture I/O failure prevents fetch and is held", async () => {
  const o = observer();
  o.onRequest = async () => {
    throw Error("private path must not leak");
  };
  const r = await run(async () => response(), { legalEvidenceObserver: o });
  assert.equal(r.calls, 0);
  assert.equal(r.result.stopReason, "error");
  assert.equal(r.result.errorMessage, "legal-evidence-held");
  assert.equal(o.seen.failures.length, 1);
});
test("response capture failure is not retried", async () => {
  const o = observer();
  o.onChunk = async () => {
    throw Error("disk error");
  };
  const r = await run(async () => response(), { legalEvidenceObserver: o });
  assert.equal(r.calls, 1);
  assert.equal(r.result.stopReason, "error");
  assert.equal(o.seen.complete.length, 0);
});
test("ordinary observer-absent request keeps normal behavior", async () => {
  let init;
  const r = await run(async (_url, value) => {
    init = value;
    return response();
  });
  assert.equal(r.result.stopReason, "stop");
  assert.equal(init.redirect, undefined);
  assert.equal(r.result.content[0].text, text);
});
test("strict SSE preserves split UTF8, CRLF and multiline data", async () => {
  const o = observer();
  const formatted = frames
    .map((e) => "data: " + JSON.stringify(e, null, 1).split("\n").join("\r\ndata: ") + "\r\n\r\n")
    .join("");
  const bytes = Buffer.from(formatted);
  const r = await run(
    async () =>
      response(
        bytes,
        200,
        [...bytes].map((b) => Uint8Array.of(b)),
      ),
    { legalEvidenceObserver: o },
  );
  assert.equal(r.result.stopReason, "stop");
  assert.deepEqual(Buffer.concat(o.seen.bytes), bytes);
  assert.equal(o.seen.complete[0].text, text);
});
for (const kind of ["malformed", "duplicate", "truncated", "invalid-utf8"]) {
  test(`strict SSE refuses ${kind}`, async () => {
    const o = observer();
    const bytes =
      kind === "malformed"
        ? Buffer.concat([Buffer.from("data: {bad}\n\n"), wire])
        : kind === "duplicate"
          ? Buffer.concat([wire, encode(terminal)])
          : kind === "invalid-utf8"
            ? Buffer.concat([Buffer.from([0xff]), wire])
            : wire.subarray(0, wire.length - 1);
    const r = await run(async () => response(bytes), { legalEvidenceObserver: o });
    assert.equal(r.result.stopReason, "error");
    assert.equal(o.seen.complete.length, 0);
  });
}
test("strict observer cannot enter websocket or custom endpoint", async () => {
  for (const change of [
    { transport: "websocket" },
    { baseUrl: "https://unreviewed.example/backend-api" },
  ]) {
    const o = observer();
    const before = model.baseUrl;
    if (change.baseUrl) {
      model.baseUrl = change.baseUrl;
    }
    try {
      const r = await run(async () => response(), { legalEvidenceObserver: o, ...change });
      assert.equal(r.calls, 0);
      assert.equal(r.result.stopReason, "error");
    } finally {
      model.baseUrl = before;
    }
  }
});
