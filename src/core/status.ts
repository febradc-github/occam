export type HostId = "claude-code" | "omp";

/** Which host surface is executing Occam in this session (spec §6.1 `activeAdapterTier`). */
export type AdapterTier = "mod" | "extension";

export interface StatusInfo {
  pluginVersion: string;
  host: HostId;
  hostVersion: string | null;
  adapterTier: AdapterTier;
  sessionId: string | null;
  cwd: string;
  stateDir: string | null;
  /** Where Occam's OpenRouter key comes from; Occam's own model calls are off without one. */
  openRouterKeySource: "env" | "saved" | null;
}

export function formatStatus(status: StatusInfo): string {
  return [
    `Occam ${status.pluginVersion}`,
    `host: ${status.host} ${status.hostVersion ?? "(version not exposed)"}`,
    `adapter tier: ${status.adapterTier}`,
    `session: ${status.sessionId ?? "(none)"}`,
    `cwd: ${status.cwd}`,
    `state dir: ${status.stateDir ?? "unresolved (set OCCAM_STATE_DIR, XDG_STATE_HOME, or HOME)"}`,
    `Occam's own model calls: ${
      status.openRouterKeySource === "env"
        ? "OpenRouter (key from OCCAM_OPENROUTER_API_KEY)"
        : status.openRouterKeySource === "saved"
          ? "OpenRouter (key from saved credentials)"
          : "off (run /occam-openrouter setup)"
    }`,
  ].join("\n");
}
