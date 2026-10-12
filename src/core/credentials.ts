// Occam's saved credentials (spec §6.4, §12): one owner-only JSON file in Occam's config directory,
// shared by the Claude Code mod and the omp extension, so `/occam-openrouter setup` on either host
// enables Occam's OpenRouter calls on both. The environment variable still wins when it is set.
import { describeKeyInfo, describeRejection, type Http, KEY_ENV, type ResolvedKey, validateKey } from "./openrouter.ts";

export const CREDENTIALS_FILE = "credentials.json";

/** File access supplied by each adapter. */
export interface CredentialStore {
  /** Absolute path of the credentials file, for messages. */
  path: string;
  /** File content, or null when the file does not exist. */
  read(): Promise<string | null>;
  /**
   * Replaces the file content. Implementations make the directory and file owner-only before the
   * text is written, and throw (writing nothing) when they cannot.
   */
  writePrivate(text: string): Promise<void>;
}

type Credentials = Record<string, unknown>;

function parseCredentials(text: string | null): { credentials: Credentials; valid: boolean } {
  if (text === null || text.trim() === "") return { credentials: {}, valid: true };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { credentials: parsed as Credentials, valid: true };
    }
  } catch {
    // Reported through `valid: false` below.
  }
  return { credentials: {}, valid: false };
}

function savedKey(credentials: Credentials): string | null {
  const entry = credentials.openrouter;
  if (typeof entry !== "object" || entry === null || !("apiKey" in entry)) return null;
  return typeof entry.apiKey === "string" && entry.apiKey !== "" ? entry.apiKey : null;
}

/** The environment variable wins over the saved key; both empty means Occam's model calls are off. */
export function resolveOpenRouterKey(envValue: string | undefined, savedText: string | null): ResolvedKey | null {
  if (envValue) return { key: envValue, source: "env" };
  const key = savedKey(parseCredentials(savedText).credentials);
  return key === null ? null : { key, source: "saved" };
}

/** Shows enough of a key to recognize it, never enough to use it. */
export function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 9)}…${key.slice(-4)}` : "…";
}

export interface SaveOptions {
  http: Http;
  store: CredentialStore;
  candidate: string;
  envKeySet: boolean;
  now: () => string;
}

/** Checks the key with OpenRouter (free) and saves it only when OpenRouter accepts it. */
export async function saveOpenRouterKey(options: SaveOptions): Promise<{ saved: boolean; message: string }> {
  const key = options.candidate.trim();
  if (key === "") return { saved: false, message: "No key entered; nothing saved." };
  if (/\s/.test(key)) return { saved: false, message: "The key contains whitespace; nothing saved." };

  const info = await validateKey(options.http, key);
  if (!info.ok) return { saved: false, message: `OpenRouter rejected the key (${describeRejection(info)}); nothing saved.` };

  const existing = parseCredentials(await options.store.read());
  const next: Credentials = { ...existing.credentials, openrouter: { apiKey: key, savedAt: options.now() } };
  try {
    await options.store.writePrivate(`${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    return {
      saved: false,
      message: `Could not store the key owner-only (${String(error)}); nothing saved. Set ${KEY_ENV} instead.`,
    };
  }
  const lines = [
    `Saved ${maskKey(key)} to ${options.store.path} (owner-only). Occam's own model calls now use it on Claude Code and omp.`,
    `OpenRouter: ${describeKeyInfo(info.value)}.`,
  ];
  if (!existing.valid) lines.push("The previous credentials file was not valid JSON and was replaced.");
  if (options.envKeySet) lines.push(`${KEY_ENV} is set in this environment and takes precedence over the saved key.`);
  return { saved: true, message: lines.join("\n") };
}

/** Deletes the saved OpenRouter key and keeps any other entries in the file. */
export async function removeOpenRouterKey(store: CredentialStore): Promise<string> {
  const existing = parseCredentials(await store.read());
  if (savedKey(existing.credentials) === null) return `No saved OpenRouter key in ${store.path}.`;
  const { openrouter: _removed, ...rest } = existing.credentials;
  try {
    await store.writePrivate(`${JSON.stringify(rest, null, 2)}\n`);
  } catch (error) {
    return `Could not update ${store.path} (${String(error)}); the key is still saved.`;
  }
  return `Removed the saved OpenRouter key from ${store.path}.`;
}
