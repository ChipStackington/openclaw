import { getCompileCacheDir, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCheckedFile } from "./files.js";
import { bytesHash, parseEvidenceJson } from "./hash.js";
import { createInstallationGuard } from "./installation.js";
import { legalEvidencePreloadKey, type LegalEvidencePreload } from "./preload-state.js";

// --import this dedicated, built-in-only entry BEFORE the engine entry. Its bootstrap and
// Node executable need external operator verification; self-measurement is not a trust root.
const configFile = process.env.OPENCLAW_LEGAL_EVIDENCE_STARTUP_FILE;
if (
  process.env.NODE_DISABLE_COMPILE_CACHE !== "1" ||
  getCompileCacheDir() !== undefined ||
  !configFile ||
  !path.isAbsolute(configFile) ||
  typeof registerHooks !== "function" ||
  Object.hasOwn(globalThis, legalEvidencePreloadKey)
) {
  throw new Error("legal-evidence-installation-preload-required");
}
const configBytes = readCheckedFile(configFile, 4_000_000);
const config = parseEvidenceJson(configBytes, 4_000_000) as {
  version: unknown;
  installationRoot: string;
  installationManifestFile: string;
  installationManifestHash: string;
};
if (config.version !== 2) {
  throw new Error("legal-evidence-installation-preload-config");
}
const guard = createInstallationGuard(config);
guard.assertFile(fileURLToPath(import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    // An optional module that cannot resolve has not loaded any bytes. Preserve the
    // original not-found error for the caller; resolved unlisted material still latches.
    const result = nextResolve(specifier, context);
    try {
      if (!result.url.startsWith("node:")) {
        if (!result.url.startsWith("file:")) {
          throw new Error("legal-evidence-installation-module");
        }
        guard.assertFile(fileURLToPath(result.url));
      }
      return result;
    } catch {
      return guard.refuse();
    }
  },
  load(url, context, nextLoad) {
    try {
      if (url.startsWith("node:")) {
        return nextLoad(url, context);
      }
      if (!url.startsWith("file:")) {
        throw new Error("legal-evidence-installation-module");
      }
      const pin = guard.assertFile(fileURLToPath(url));
      const result = nextLoad(url, context);
      if (result.format === "addon") {
        return result;
      }
      if (
        result.source === null ||
        result.source === undefined ||
        bytesHash(
          typeof result.source === "string"
            ? result.source
            : ArrayBuffer.isView(result.source)
              ? new Uint8Array(
                  result.source.buffer,
                  result.source.byteOffset,
                  result.source.byteLength,
                )
              : new Uint8Array(result.source),
        ) !== pin
      ) {
        throw new Error("legal-evidence-installation-loaded-bytes");
      }
      return result;
    } catch {
      return guard.refuse();
    }
  },
});
const state: LegalEvidencePreload = Object.freeze({
  configFile,
  configHash: bytesHash(configBytes),
  guard,
});
Object.defineProperty(globalThis, legalEvidencePreloadKey, {
  value: state,
  writable: false,
  configurable: false,
});
