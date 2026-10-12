/** Reads one environment variable; returns undefined when it is unset. */
export type EnvLookup = (name: string) => string | undefined;

/** Returns the value without trailing separators when it is an absolute POSIX or Windows path; otherwise null. */
function usable(value: string | undefined): string | null {
  if (value === undefined || !(value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value))) return null;
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed === "" ? value.slice(0, 1) : trimmed;
}

/**
 * `$<explicitVar>`, then `$<xdgVar>/occam`, then `$HOME/<homeSubdir>/occam`. Empty and relative values are
 * skipped; the XDG Base Directory spec requires ignoring relative XDG paths. Null when nothing is usable.
 */
function resolveOccamDir(env: EnvLookup, explicitVar: string, xdgVar: string, homeSubdir: string): string | null {
  const explicit = usable(env(explicitVar));
  if (explicit) return explicit;
  const xdg = usable(env(xdgVar));
  if (xdg) return `${xdg}/occam`;
  const home = usable(env("HOME"));
  if (home) return `${home}/${homeSubdir}/occam`;
  return null;
}

/** Occam's state directory (spec §5.7): index, ledger, vault. */
export function resolveStateDir(env: EnvLookup): string | null {
  return resolveOccamDir(env, "OCCAM_STATE_DIR", "XDG_STATE_HOME", ".local/state");
}

/** Occam's config directory (spec §13): config.yml and the owner-only credentials.json. */
export function resolveConfigDir(env: EnvLookup): string | null {
  return resolveOccamDir(env, "OCCAM_CONFIG_DIR", "XDG_CONFIG_HOME", ".config");
}
