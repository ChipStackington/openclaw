// Resolves the optional, operator-configured Judge sink from core config.
// The sink is the Quinn-Co workspace endpoint that feeds completed agent
// tasks into the judge. Returns undefined (→ emit skipped) unless both
// url and token are present, keeping core fully decoupled by default.

export interface JudgeSinkConfig {
  url: string;
  token: string;
  department?: string;
}

export function resolveJudgeSink(cfg: {
  judgeSink?: { url?: string; token?: string; department?: string };
}): JudgeSinkConfig | undefined {
  const s = cfg.judgeSink;
  if (!s) return undefined;
  const url = typeof s.url === "string" ? s.url.trim() : "";
  const token = typeof s.token === "string" ? s.token.trim() : "";
  if (!url || !token) return undefined;
  const department = typeof s.department === "string" && s.department.trim() ? s.department.trim() : undefined;
  return department ? { url, token, department } : { url, token };
}
