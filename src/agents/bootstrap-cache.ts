import {
  computeWorkspaceBootstrapVersion,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const cache = new Map<string, { files: WorkspaceBootstrapFile[]; version: string }>();

export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  // Revalidate the snapshot against on-disk state every call: without this,
  // live sessions serve boot-time bootstrap content (IDENTITY.md etc.) until
  // a gateway restart or /new — same staleness class as the skills snapshot.
  const version = await computeWorkspaceBootstrapVersion(params.workspaceDir);
  const existing = cache.get(params.sessionKey);
  if (existing && existing.version === version) {
    return existing.files;
  }

  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  cache.set(params.sessionKey, { files, version });
  return files;
}

export function clearBootstrapSnapshot(sessionKey: string): void {
  cache.delete(sessionKey);
}

export function clearBootstrapSnapshotOnSessionRollover(params: {
  sessionKey?: string;
  previousSessionId?: string;
}): void {
  if (!params.sessionKey || !params.previousSessionId) {
    return;
  }

  clearBootstrapSnapshot(params.sessionKey);
}

export function clearAllBootstrapSnapshots(): void {
  cache.clear();
}
