/**
 * Bridge into the core's extension API (dist/extensionAPI.js).
 * Trimmed copy of voice-call/src/core-bridge.ts — extensions stay
 * self-contained. Gives the SMS agent access to runEmbeddedPiAgent so
 * model auth (Codex OAuth + refresh) stays in core.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type CoreConfig = {
  session?: { store?: string };
  [key: string]: unknown;
};

export type CoreAgentDeps = {
  resolveAgentDir: (cfg: CoreConfig, agentId: string) => string;
  resolveAgentWorkspaceDir: (cfg: CoreConfig, agentId: string) => string;
  resolveThinkingDefault: (params: {
    cfg: CoreConfig;
    provider?: string;
    model?: string;
  }) => string;
  runEmbeddedPiAgent: (params: {
    sessionId: string;
    sessionKey?: string;
    messageProvider?: string;
    sessionFile: string;
    workspaceDir: string;
    config?: CoreConfig;
    prompt: string;
    provider?: string;
    model?: string;
    thinkLevel?: string;
    verboseLevel?: string;
    timeoutMs: number;
    runId: string;
    lane?: string;
    extraSystemPrompt?: string;
    agentDir?: string;
  }) => Promise<{
    payloads?: Array<{ text?: string; isError?: boolean }>;
    meta?: { aborted?: boolean };
  }>;
  resolveAgentTimeoutMs: (opts: { cfg: CoreConfig }) => number;
  ensureAgentWorkspace: (params?: { dir: string }) => Promise<void>;
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
  loadSessionStore: (storePath: string) => Record<string, unknown>;
  saveSessionStore: (storePath: string, store: Record<string, unknown>) => Promise<void>;
  resolveSessionFilePath: (
    sessionId: string,
    entry: unknown,
    opts?: { agentId?: string },
  ) => string;
  DEFAULT_MODEL: string;
  DEFAULT_PROVIDER: string;
};

let coreRootCache: string | null = null;
let coreDepsPromise: Promise<CoreAgentDeps> | null = null;

function findPackageRoot(startDir: string, name: string): string | null {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as { name?: string };
        if (pkg.name === name) return dir;
      }
    } catch {
      // ignore parse errors and keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveOpenClawRoot(): string {
  if (coreRootCache) return coreRootCache;
  const candidates = new Set<string>();
  const envRoot = process.env.OPENCLAW_ROOT;
  if (envRoot) candidates.add(envRoot);
  candidates.add(process.cwd());
  try {
    candidates.add(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // ignore
  }
  for (const start of candidates) {
    const found = findPackageRoot(start, "openclaw");
    if (found) {
      coreRootCache = found;
      return found;
    }
  }
  throw new Error("Unable to resolve core root. Set OPENCLAW_ROOT to the package root.");
}

async function importCoreExtensionAPI(): Promise<CoreAgentDeps> {
  const distPath = path.join(resolveOpenClawRoot(), "dist", "extensionAPI.js");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Missing core module at ${distPath}. Run \`pnpm build\` or install the official package.`,
    );
  }
  return (await import(pathToFileURL(distPath).href)) as CoreAgentDeps;
}

export async function loadCoreAgentDeps(): Promise<CoreAgentDeps> {
  if (!coreDepsPromise) coreDepsPromise = importCoreExtensionAPI();
  return coreDepsPromise;
}
