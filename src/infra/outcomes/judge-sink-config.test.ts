import { describe, expect, it } from "vitest";
import { resolveJudgeSink } from "./judge-sink-config.js";

describe("resolveJudgeSink", () => {
  it("returns undefined when judgeSink is absent", () => {
    expect(resolveJudgeSink({})).toBeUndefined();
  });
  it("returns undefined when url or token is missing/blank", () => {
    expect(resolveJudgeSink({ judgeSink: { url: "http://x", token: "  " } })).toBeUndefined();
    expect(resolveJudgeSink({ judgeSink: { url: "", token: "t" } })).toBeUndefined();
  });
  it("returns trimmed config when complete", () => {
    expect(
      resolveJudgeSink({ judgeSink: { url: " http://127.0.0.1:4242 ", token: " tok ", department: " sales " } }),
    ).toEqual({ url: "http://127.0.0.1:4242", token: "tok", department: "sales" });
  });
  it("omits department when blank", () => {
    expect(resolveJudgeSink({ judgeSink: { url: "u", token: "t", department: "  " } })).toEqual({
      url: "u",
      token: "t",
    });
  });
});
