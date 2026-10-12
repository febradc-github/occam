import assert from "node:assert/strict";
import { test } from "node:test";
import { type CredentialStore, removeOpenRouterKey, resolveOpenRouterKey, saveOpenRouterKey } from "./credentials.ts";
import type { Http } from "./openrouter.ts";

const KEY = "sk-or-v1-0123456789abcdef";

function memoryStore(initial: string | null, failWrites = false): CredentialStore & { content: string | null; writes: number } {
  const store = {
    path: "/home/u/.config/occam/credentials.json",
    content: initial,
    writes: 0,
    read: async () => store.content,
    writePrivate: async (text: string) => {
      if (failWrites) throw new Error("chmod failed");
      store.writes += 1;
      store.content = text;
    },
  };
  return store;
}

const openRouter = (status: number): Http => async () => ({
  status,
  text: status === 200 ? JSON.stringify({ data: { label: "occam", limit_remaining: 5, usage_monthly: 0.01 } }) : JSON.stringify({ error: { message: "Missing Authentication header", code: 401 } }),
});

const save = (store: CredentialStore, http: Http, envKeySet = false) =>
  saveOpenRouterKey({ http, store, candidate: ` ${KEY}\n`, envKeySet, now: () => "2026-10-12T00:00:00Z" });

test("the environment variable wins over the saved key", () => {
  const saved = JSON.stringify({ openrouter: { apiKey: "sk-or-saved" } });
  assert.deepEqual(resolveOpenRouterKey("sk-or-env", saved), { key: "sk-or-env", source: "env" });
  assert.deepEqual(resolveOpenRouterKey(undefined, saved), { key: "sk-or-saved", source: "saved" });
  assert.deepEqual(resolveOpenRouterKey("", saved), { key: "sk-or-saved", source: "saved" });
  assert.equal(resolveOpenRouterKey(undefined, "{not json"), null);
});

test("a key OpenRouter rejects is never written", async () => {
  const store = memoryStore(null);
  const result = await save(store, openRouter(401));
  assert.equal(result.saved, false);
  assert.equal(store.writes, 0);
});

test("an accepted key is saved trimmed, next to entries Occam does not own", async () => {
  const store = memoryStore(JSON.stringify({ other: { token: "keep" } }));
  const result = await save(store, openRouter(200), true);
  assert.equal(result.saved, true);
  assert.deepEqual(JSON.parse(store.content ?? ""), {
    other: { token: "keep" },
    openrouter: { apiKey: KEY, savedAt: "2026-10-12T00:00:00Z" },
  });
  assert.match(result.message, /takes precedence/);
  assert.doesNotMatch(result.message, new RegExp(KEY));
});

test("when owner-only storage fails, nothing is reported as saved", async () => {
  const result = await save(memoryStore(null, true), openRouter(200));
  assert.equal(result.saved, false);
});

test("remove deletes only the OpenRouter entry", async () => {
  const store = memoryStore(JSON.stringify({ other: 1, openrouter: { apiKey: KEY } }));
  await removeOpenRouterKey(store);
  assert.deepEqual(JSON.parse(store.content ?? ""), { other: 1 });
  assert.equal(resolveOpenRouterKey(undefined, store.content), null);
});
