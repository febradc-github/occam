import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { CREDENTIALS_FILE, type CredentialStore } from "../../core/credentials.ts";

/**
 * Owner-only credentials file for the omp extension (Bun). The directory becomes 0700 and the file
 * 0600 before any key bytes are written; an existing file with wider permissions is tightened first.
 * On Windows chmod only toggles read-only, so protection there rests on the profile's ACLs.
 */
export function fileCredentialStore(dir: string): CredentialStore {
  const path = `${dir}/${CREDENTIALS_FILE}`;
  return {
    path,
    async read() {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async writePrivate(text) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      await (await open(path, "a", 0o600)).close();
      await chmod(path, 0o600);
      await writeFile(path, text, "utf8");
    },
  };
}
