import type { InstallationGuard } from "./installation.js";

export const legalEvidencePreloadKey = Symbol.for(
  "openclaw.legal-evidence.installation-preload.v1",
);
export type LegalEvidencePreload = Readonly<{
  configFile: string;
  configHash: string;
  guard: InstallationGuard;
}>;
export function readLegalEvidencePreload(
  configFile: string,
  configHash: string,
  root: string,
  manifestHash: string,
): InstallationGuard {
  const state = (
    globalThis as typeof globalThis & { [legalEvidencePreloadKey]?: LegalEvidencePreload }
  )[legalEvidencePreloadKey];
  if (
    !state ||
    state.configFile !== configFile ||
    state.configHash !== configHash ||
    state.guard.root !== root ||
    state.guard.manifestHash !== manifestHash
  ) {
    throw new Error("legal-evidence-installation-preload-required");
  }
  return state.guard;
}
