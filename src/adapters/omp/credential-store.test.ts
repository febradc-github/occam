import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileCredentialStore } from "./credential-store.ts";

test("the credentials file and its directory end up owner-only, even when they existed with wider modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "occam-store-test-"));
  try {
    const dir = join(root, "occam");
    const store = fileCredentialStore(dir);
    assert.equal(await store.read(), null);

    await store.writePrivate("{}\n");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(store.path).mode & 0o777, 0o600);

    writeFileSync(store.path, "old", { mode: 0o644 });
    await store.writePrivate('{"openrouter":{"apiKey":"k"}}\n');
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.equal(await store.read(), '{"openrouter":{"apiKey":"k"}}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
