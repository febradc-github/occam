// Usage accounting contract (spec §10.1–10.2). Null means not reported; zero means measured zero.
import type { HostId } from "./status.ts";

export type Purpose =
  | "execution"
  | "retry"
  | "verification"
  | "review"
  | "routing"
  | "retrieval"
  | "compression"
  | "indexing"
  | "semantic_extraction"
  | "compaction"
  | "advisor"
  | "host_overhead"
  | "diagnostics";

export interface UsageRecord {
  recordId: string;
  host: HostId;
  model: string | null;
  provider: string | null;
  executorRole: "main" | "subagent" | "advisor" | "headless_stage" | "side_call";
  purpose: Purpose;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWriteBreakdown: { ttl5m: number | null; ttl1h: number | null } | null;
  serverToolUses: Record<string, number> | null;
  estimatedCost: number | null;
  actualCost: number | null;
  costBasis: "provider_reported" | "host_estimate" | "occam_estimate" | null;
  pricingVersion: string | null;
  currency: string | null;
  usageStatus: "provider_reported" | "partially_reported" | "estimated" | "unavailable";
  source: string | null;
  observedAt: string;
}
