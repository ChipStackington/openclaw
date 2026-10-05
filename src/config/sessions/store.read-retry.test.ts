import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest, loadSessionStore } from "./store.js";

describe("Windows session store read recovery", () => {
  let root: string;
  let file: string;
  const record = { "agent:test:main": { sessionId: "test", updatedAt: 123 } };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "session-read-retry-"));
    file = path.join(root, "sessions.json");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("OPENCLAW_SESSION_CACHE_TTL_MS", "45000");
    clearSessionStoreCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearSessionStoreCacheForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])("does not block for a never-created store (skipCache=%s)", (skipCache) => {
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    expect(loadSessionStore(file, { skipCache })).toEqual({});
    expect(wait).not.toHaveBeenCalled();
  });

  it("reads a newly created file after a cached absence", () => {
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    expect(loadSessionStore(file)).toEqual({});
    fs.writeFileSync(file, JSON.stringify(record));
    expect(loadSessionStore(file)).toEqual(record);
  });

  it("recovers a first read during a writer's locked replacement gap", () => {
    fs.writeFileSync(`${file}.lock`, "writer fixture");
    const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
      fs.writeFileSync(file, JSON.stringify(record));
      return "timed-out";
    });
    expect(loadSessionStore(file)).toEqual(record);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(`${file}.lock`, "utf8")).toBe("writer fixture");
  });

  it.each(["", "{incomplete"])("recovers an existing partial write %j", (partial) => {
    fs.writeFileSync(file, partial);
    const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
      fs.writeFileSync(file, JSON.stringify(record));
      return "timed-out";
    });
    expect(loadSessionStore(file)).toEqual(record);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it.each(["EACCES", "EPERM", "EBUSY", "ENOENT"])(
    "recovers %s after observing the existing file",
    (code) => {
      fs.writeFileSync(file, JSON.stringify(record));
      const read = fs.readFileSync.bind(fs);
      let failed = false;
      vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
        if (args[0] === file && !failed) {
          failed = true;
          throw Object.assign(new Error("transient read"), { code });
        }
        return read(...args);
      });
      const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
      expect(loadSessionStore(file)).toEqual(record);
      expect(wait).toHaveBeenCalledTimes(1);
    },
  );

  it("recovers a previously loaded file missing before stat/cache invalidation", () => {
    fs.writeFileSync(file, JSON.stringify(record));
    expect(loadSessionStore(file)).toEqual(record);
    fs.unlinkSync(file);
    const replacement = { ...record, next: { sessionId: "next", updatedAt: 456 } };
    const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
      fs.writeFileSync(file, JSON.stringify(replacement));
      return "timed-out";
    });
    expect(loadSessionStore(file)).toEqual(replacement);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("does not return cached content after the file stays deleted", () => {
    fs.writeFileSync(file, JSON.stringify(record));
    loadSessionStore(file);
    fs.unlinkSync(file);
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    expect(loadSessionStore(file)).toEqual({});
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
