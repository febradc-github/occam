// OpenRouter client for Occam's own model calls (spec §6.4). The hosts keep their own providers
// (Claude Code and omp stay on the user's Claude subscription); only Occam's side work
// (classification, semantic extraction, summaries, diagnostics) goes to OpenRouter.
// No I/O of its own: adapters supply the `Http` port and the clock.
import type { HostId } from "./status.ts";
import type { Purpose, UsageRecord } from "./usage.ts";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";

/** Model for Occam's side calls until tier models are chosen (decision of 2026-10-12: decide later). */
export const DEFAULT_SIDE_CALL_MODEL = "anthropic/claude-haiku-5.5";

/**
 * Occam's key comes from this variable or, when it is unset, from the owner-only credentials file that
 * `/occam-openrouter setup` writes (credentials.ts). Occam never reads OPENROUTER_API_KEY: omp uses that
 * name to enable its own OpenRouter provider, and a key set for other tools must not start sending
 * code to OpenRouter without an explicit opt-in (spec §12). A dedicated key can also carry its own
 * OpenRouter credit limit, which caps Occam's spend independently of the hosts.
 */
export const KEY_ENV = "OCCAM_OPENROUTER_API_KEY";

/** The key Occam will use and where it came from. */
export interface ResolvedKey {
  key: string;
  source: "env" | "saved";
}

/** Occam sends code excerpts, so only endpoints that neither collect data nor retain prompts are eligible. */
export const PROVIDER_POLICY = { data_collection: "deny", zdr: true } as const;

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type Failure = { ok: false; status: number; message: string; limitSource: string | null };
export type Result<T> = { ok: true; value: T } | Failure;

export function chatRequest(apiKey: string, model: string, messages: ChatMessage[], maxTokens: number): HttpRequest {
  return {
    url: `${OPENROUTER_API}/chat/completions`,
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, provider: PROVIDER_POLICY }),
  };
}

/** Reads a nested field from parsed JSON without trusting its shape. */
function get(value: unknown, ...path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Parses a 2xx JSON body that carries no `error` object; anything else becomes the failure to report. */
function parseBody(response: HttpResponse): { ok: true; body: unknown } | Failure {
  let body: unknown = undefined;
  try {
    body = JSON.parse(response.text);
  } catch {
    body = undefined;
  }
  if (response.status >= 200 && response.status < 300 && body !== undefined && get(body, "error") === undefined) {
    return { ok: true, body };
  }
  return {
    ok: false,
    status: response.status,
    message: str(get(body, "error", "message")) ?? (response.text.slice(0, 300) || `HTTP ${response.status}`),
    limitSource: str(get(body, "error", "metadata", "limit_source")),
  };
}

export interface ChatCompletion {
  text: string;
  usage: UsageRecord;
}

/**
 * Maps an OpenRouter chat completion to Occam's disjoint token kinds (spec §10.1). OpenRouter follows
 * the OpenAI convention that `prompt_tokens` includes cached tokens, so uncached input is derived by
 * subtraction *[verify cache-write inclusion on the first live call]*. Missing fields stay null.
 */
export function parseChatResponse(
  response: HttpResponse,
  context: { host: HostId; purpose: Purpose; observedAt: string },
): Result<ChatCompletion> {
  const parsed = parseBody(response);
  if (!parsed.ok) return parsed;
  const { body } = parsed;
  const prompt = num(get(body, "usage", "prompt_tokens"));
  const cacheRead = num(get(body, "usage", "prompt_tokens_details", "cached_tokens"));
  const cacheWrite = num(get(body, "usage", "prompt_tokens_details", "cache_write_tokens"));
  const output = num(get(body, "usage", "completion_tokens"));
  const cost = num(get(body, "usage", "cost"));
  const reported = [prompt, cacheRead, output, cost].filter((value) => value !== null).length;
  return {
    ok: true,
    value: {
      text: str(get(body, "choices", 0, "message", "content")) ?? "",
      usage: {
        recordId: str(get(body, "id")) ?? `openrouter:unidentified:${context.observedAt}`,
        host: context.host,
        model: str(get(body, "model")),
        provider: str(get(body, "provider")),
        executorRole: "side_call",
        purpose: context.purpose,
        inputTokens: prompt !== null && cacheRead !== null ? prompt - cacheRead - (cacheWrite ?? 0) : prompt,
        outputTokens: output,
        reasoningTokens: num(get(body, "usage", "completion_tokens_details", "reasoning_tokens")),
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        cacheWriteBreakdown: null,
        serverToolUses: null,
        estimatedCost: null,
        actualCost: cost,
        costBasis: cost === null ? null : "provider_reported",
        pricingVersion: null,
        currency: cost === null ? null : "USD",
        usageStatus: reported === 4 ? "provider_reported" : reported === 0 ? "unavailable" : "partially_reported",
        source: "occam:openrouter",
        observedAt: context.observedAt,
      },
    },
  };
}

export interface CheckOptions {
  http: Http;
  key: ResolvedKey | null;
  model: string;
  live: boolean;
  host: HostId;
  now: () => string;
}

const usd = (value: number): string => `$${value.toFixed(value < 0.01 ? 7 : 2)}`;

/** Calls the port and turns a thrown error (network failure, refused mod call) into an error response. */
async function send(http: Http, request: HttpRequest): Promise<HttpResponse> {
  try {
    return await http(request);
  } catch (error) {
    return { status: 0, text: JSON.stringify({ error: { message: `request failed: ${String(error)}` } }) };
  }
}

export interface KeyInfo {
  label: string | null;
  limitRemaining: number | null;
  usageMonthly: number | null;
}

/** Checks a key against OpenRouter's free key-info endpoint. */
export async function validateKey(http: Http, apiKey: string): Promise<Result<KeyInfo>> {
  const response = parseBody(
    await send(http, { url: `${OPENROUTER_API}/key`, method: "GET", headers: { authorization: `Bearer ${apiKey}` } }),
  );
  if (!response.ok) return response;
  return {
    ok: true,
    value: {
      label: str(get(response.body, "data", "label")),
      limitRemaining: num(get(response.body, "data", "limit_remaining")),
      usageMonthly: num(get(response.body, "data", "usage_monthly")),
    },
  };
}

export function describeKeyInfo(info: KeyInfo): string {
  const limit = info.limitRemaining === null ? "no credit limit set" : `${usd(info.limitRemaining)} of credit limit left`;
  const monthly = info.usageMonthly === null ? "unknown" : usd(info.usageMonthly);
  return `${info.label ? `label "${info.label}"; ` : ""}${limit}; used this month ${monthly}`;
}

/**
 * OpenRouter answers an invalid or revoked key with "Missing Authentication header"; a request that
 * truly lacks the header gets "No cookie auth credentials found" instead. Explain the first case.
 */
export function describeRejection(failure: Failure): string {
  const hint = failure.status === 401 ? " - OpenRouter returns this for invalid or revoked keys" : "";
  return `${failure.status}: ${failure.message}${hint}`;
}

/**
 * Diagnoses Occam's OpenRouter setup. Without `live` it only uses free endpoints (model endpoints,
 * ZDR endpoint list, key info). With `live` it also makes one tiny chat completion and reports the
 * provider-reported usage.
 */
export async function checkOpenRouter(options: CheckOptions): Promise<{ report: string; usage: UsageRecord | null }> {
  const { http, key, model, live, host, now } = options;
  const lines = [
    "OpenRouter: Occam's own model calls only (Claude Code and omp keep their own providers)",
    `routing: data_collection=${PROVIDER_POLICY.data_collection}, zdr=${PROVIDER_POLICY.zdr}`,
  ];

  const endpoints = parseBody(await send(http, { url: `${OPENROUTER_API}/models/${model}/endpoints`, method: "GET", headers: {} }));
  if (!endpoints.ok) {
    lines.push(`model: ${model} - not available (${endpoints.status}: ${endpoints.message})`);
  } else {
    const list = get(endpoints.body, "data", "endpoints");
    const endpointCount = Array.isArray(list) ? list.length : 0;
    const zdr = parseBody(await send(http, { url: `${OPENROUTER_API}/endpoints/zdr`, method: "GET", headers: {} }));
    const zdrList = zdr.ok ? get(zdr.body, "data") : undefined;
    const zdrCount = Array.isArray(zdrList) ? zdrList.filter((entry) => get(entry, "model_id") === model).length : null;
    const prompt = Number(get(list, 0, "pricing", "prompt"));
    const completion = Number(get(list, 0, "pricing", "completion"));
    const pricing =
      Number.isFinite(prompt) && Number.isFinite(completion)
        ? `, ${usd(prompt * 1e6)} / ${usd(completion * 1e6)} per M tokens in/out`
        : "";
    lines.push(`model: ${model} - ${endpointCount} endpoints, ${zdrCount ?? "unknown"} ZDR${pricing}`);
    if (zdrCount === 0) lines.push("warning: no ZDR endpoint serves this model, so OpenRouter will refuse every Occam call to it");
  }

  if (key === null) {
    lines.push(`key: not set - run \`/occam-openrouter setup\` or export ${KEY_ENV} to enable Occam's model calls`);
    return { report: lines.join("\n"), usage: null };
  }
  const source = key.source === "env" ? KEY_ENV : "saved credentials";
  const info = await validateKey(http, key.key);
  if (!info.ok) {
    lines.push(`key (from ${source}): rejected (${describeRejection(info)})`);
    return { report: lines.join("\n"), usage: null };
  }
  lines.push(`key (from ${source}): valid; ${describeKeyInfo(info.value)}`);
  if (!live) {
    lines.push("live call: skipped (add `live` to spend a fraction of a cent on one test completion)");
    return { report: lines.join("\n"), usage: null };
  }

  const request = chatRequest(key.key, model, [{ role: "user", content: "Reply with exactly: OK" }], 5);
  const completion = parseChatResponse(await send(http, request), { host, purpose: "diagnostics", observedAt: now() });
  if (!completion.ok) {
    const limit = completion.limitSource ? `; limit: ${completion.limitSource}` : "";
    lines.push(`live call: failed (${completion.status}: ${completion.message}${limit})`);
    return { report: lines.join("\n"), usage: null };
  }
  const usage = completion.value.usage;
  lines.push(
    `live call: "${completion.value.text.trim()}" from ${usage.model ?? "unknown model"} via ${usage.provider ?? "unknown provider"}; ` +
      `input ${usage.inputTokens ?? "?"} (cache read ${usage.cacheReadTokens ?? "?"}, write ${usage.cacheWriteTokens ?? "?"}), ` +
      `output ${usage.outputTokens ?? "?"}; cost ${usage.actualCost === null ? "not reported" : `${usd(usage.actualCost)} (provider-reported)`}; ` +
      `usage ${usage.usageStatus}`,
  );
  return { report: lines.join("\n"), usage };
}
