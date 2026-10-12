import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOpenRouter, type HttpRequest, parseChatResponse } from "./openrouter.ts";

const context = { host: "omp", purpose: "diagnostics", observedAt: "2026-10-12T00:00:00Z" } as const;

test("chat usage maps to disjoint token kinds with provider-reported cost", () => {
  const result = parseChatResponse(
    {
      status: 200,
      text: JSON.stringify({
        id: "gen-1",
        model: "anthropic/claude-haiku-5.5",
        provider: "Google",
        choices: [{ message: { content: "OK" } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 2,
          completion_tokens_details: { reasoning_tokens: 0 },
          prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 30 },
          cost: 0.0000123,
        },
      }),
    },
    context,
  );
  assert.ok(result.ok);
  const usage = result.value.usage;
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.cacheReadTokens, 80);
  assert.equal(usage.cacheWriteTokens, 30);
  assert.equal(usage.actualCost, 0.0000123);
  assert.equal(usage.costBasis, "provider_reported");
  assert.equal(usage.usageStatus, "provider_reported");
});

test("missing usage stays null instead of becoming zero", () => {
  const result = parseChatResponse({ status: 200, text: JSON.stringify({ choices: [{ message: { content: "OK" } }] }) }, context);
  assert.ok(result.ok);
  const usage = result.value.usage;
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.actualCost, null);
  assert.equal(usage.costBasis, null);
  assert.equal(usage.usageStatus, "unavailable");
});

test("credit errors and in-body errors are failures that keep the limit source", () => {
  const credit = parseChatResponse(
    {
      status: 402,
      text: JSON.stringify({ error: { code: 402, message: "insufficient credits", metadata: { limit_source: "openrouter_credits" } } }),
    },
    context,
  );
  assert.deepEqual(credit, { ok: false, status: 402, message: "insufficient credits", limitSource: "openrouter_credits" });
  const inBody = parseChatResponse({ status: 200, text: JSON.stringify({ error: { message: "upstream failed" } }) }, context);
  assert.equal(inBody.ok, false);
});

async function requestsMade(apiKey: string | null, live: boolean): Promise<HttpRequest[]> {
  const requests: HttpRequest[] = [];
  await checkOpenRouter({
    http: async (request) => {
      requests.push(request);
      return { status: 200, text: JSON.stringify({ data: { endpoints: [], label: "k" } }) };
    },
    key: apiKey === null ? null : { key: apiKey, source: "saved" },
    model: "anthropic/claude-haiku-5.5",
    live,
    host: "claude-code",
    now: () => "2026-10-12T00:00:00Z",
  });
  return requests;
}

test("the check sends no key and makes no completion unless a key is set and live is requested", async () => {
  const withoutKey = await requestsMade(null, true);
  assert.ok(withoutKey.every((request) => request.headers.authorization === undefined && request.method === "GET"));
  const notLive = await requestsMade("sk-or-test", false);
  assert.ok(notLive.every((request) => request.method === "GET"));
  const live = await requestsMade("sk-or-test", true);
  assert.equal(live.filter((request) => request.method === "POST").length, 1);
});
