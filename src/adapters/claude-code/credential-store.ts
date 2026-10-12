import { CREDENTIALS_FILE, type CredentialStore } from "../../core/credentials.ts";

/** File and process access, built from `$` call sites inside a mod hook. */
export interface ModFilePorts {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  run(argv: string[]): Promise<{ exitCode: number; stderr: string }>;
}

/**
 * Owner-only credentials file for the Claude Code mod. `$.fs` has no mkdir or chmod, and its write
 * creates missing directories and replaces content in place. So: create the file empty, tighten the
 * directory to 0700 and the file to 0600 with `chmod`, and only then write the key. A failed or
 * unavailable `chmod` throws before any key bytes are written.
 */
export function modCredentialStore(dir: string, ports: ModFilePorts): CredentialStore {
  const path = `${dir}/${CREDENTIALS_FILE}`;
  return {
    path,
    read: async () => ((await ports.exists(path)) ? await ports.read(path) : null),
    async writePrivate(text) {
      if (!(await ports.exists(path))) await ports.write(path, "");
      for (const [mode, target] of [
        ["700", dir],
        ["600", path],
      ]) {
        const result = await ports.run(["chmod", mode, target]);
        if (result.exitCode !== 0) throw new Error(`chmod ${mode} ${target} failed: ${result.stderr.trim()}`);
      }
      await ports.write(path, text);
    },
  };
}
