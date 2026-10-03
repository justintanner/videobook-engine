import type { EngineContext } from "./context.js";
import { syncResultOf } from "./context.js";
import { canonicalJson, EngineFault, parseJson } from "./store.js";

export interface UsageEntry {
  id: string;
  provider: string;
  model: string;
  activity: "images" | "video" | "audio" | "chat" | "voice" | "analysis";
  status: "pending" | "completed" | "failed" | "cancelled" | "uncertain";
  basis: "reported" | "estimated" | "unknown" | "free";
  externalId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  tokenBased: boolean;
  costUsd: number | null;
  units: number | null;
  unit: string | null;
  rateSource: string | null;
  pricingVersion: string | null;
  artifactId: string | null;
  operation: string | null;
  warnings: string[];
  createdAt: number;
  updatedAt: number;
}

export type UsageInput = Pick<UsageEntry, "id" | "provider" | "model" | "activity"> & Partial<Omit<UsageEntry, "updatedAt">>;

export interface UsageTotals {
  count: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  missingTokens: number;
  reportedUsd: number;
  estimatedUsd: number;
  unpriced: number;
  pendingCount: number;
  pendingUsd: number;
}

export interface UsageGroup extends UsageTotals {
  activity: UsageEntry["activity"];
  provider: string;
  model: string;
}

export interface UsageSummary {
  trackedSince: number;
  currency: "USD";
  totals: UsageTotals;
  groups: UsageGroup[];
}

type StoredRow = { body_json: string };
type AggregateRow = Omit<UsageGroup, "reportedUsd" | "estimatedUsd" | "pendingUsd"> & {
  reportedNanos: number;
  estimatedNanos: number;
  pendingNanos: number;
};

const activities = new Set(["images", "video", "audio", "chat", "voice", "analysis"]);
const statuses = new Set(["pending", "completed", "failed", "cancelled", "uncertain"]);
const bases = new Set(["reported", "estimated", "unknown", "free"]);

function invalid(message: string): never {
  throw new EngineFault({ code: "INVALID_INPUT", message });
}

function validate(entry: UsageEntry): void {
  for (const name of ["id", "provider", "model"] as const) {
    if (!entry[name]?.trim() || entry[name].length > 500) invalid(`Invalid usage ${name}`);
  }
  if (!activities.has(entry.activity) || !statuses.has(entry.status) || !bases.has(entry.basis)) invalid("Invalid usage classification");
  for (const name of ["inputTokens", "outputTokens", "cachedTokens", "createdAt"] as const) {
    const n = entry[name];
    if (n !== null && (!Number.isSafeInteger(n) || n < 0)) invalid(`Invalid usage ${name}`);
  }
  if (entry.cachedTokens !== null && entry.inputTokens !== null && entry.cachedTokens > entry.inputTokens) invalid("Cached tokens exceed input tokens");
  for (const name of ["costUsd", "units"] as const) {
    const n = entry[name];
    if (n !== null && (!Number.isFinite(n) || n < 0)) invalid(`Invalid usage ${name}`);
  }
  if (entry.costUsd !== null && !Number.isSafeInteger(Math.round(entry.costUsd * 1e9))) invalid("Usage cost exceeds precision limit");
  if (entry.basis === "unknown") entry.costUsd = null;
  if (entry.basis === "free") entry.costUsd = 0;
}

export function createUsageApi(context: EngineContext) {
  context.store.runtime((now) => {
    context.store.db.prepare("INSERT INTO runtime_meta(key, value_json, updated_at) VALUES ('usage_started_at', ?, ?) ON CONFLICT(key) DO NOTHING").run(String(now), now);
  });

  const decode = (row: StoredRow | undefined): UsageEntry | null => row ? parseJson<UsageEntry | null>(row.body_json, null) : null;
  const read = (id: string): UsageEntry | null => decode(context.store.db.prepare("SELECT body_json FROM runtime_usage WHERE id=?").get(id) as StoredRow | undefined);
  const find = (provider: string, externalId: string): UsageEntry | null => decode(context.store.db.prepare("SELECT body_json FROM runtime_usage WHERE provider=? AND external_id=?").get(provider, externalId) as StoredRow | undefined);

  const record = (input: UsageInput) => syncResultOf(() => context.store.runtime((now) => {
    const byId = read(input.id);
    const external = input.externalId ? find(input.provider, input.externalId) : null;
    const current = external ?? byId;
    if (current && (current.provider !== input.provider || current.model !== input.model || current.activity !== input.activity)) invalid("Usage identity cannot change");
    if (current && current.status !== "pending" && current.status !== "uncertain" && input.status === "pending") return current;
    const entry: UsageEntry = {
      status: "pending", basis: "unknown", externalId: null,
      inputTokens: null, outputTokens: null, cachedTokens: null, tokenBased: false,
      costUsd: null, units: null, unit: null, rateSource: null, pricingVersion: null,
      artifactId: null, operation: null, warnings: [], createdAt: now,
      ...current, ...input, id: current?.id ?? input.id, updatedAt: now,
    };
    if (current) entry.createdAt = current.createdAt;
    if (current?.basis === "reported" && input.basis !== "reported") {
      entry.costUsd = current.costUsd;
      entry.basis = current.basis;
      entry.rateSource = current.rateSource;
    }
    validate(entry);
    if (external && byId && byId.id !== external.id) context.store.db.prepare("DELETE FROM runtime_usage WHERE id=?").run(byId.id);
    context.store.db.prepare(`INSERT INTO runtime_usage
      (id, provider, external_id, activity, model, status, basis, input_tokens, output_tokens, cached_tokens, token_based, cost_nanos, body_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id, status=excluded.status,
      basis=excluded.basis, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      cached_tokens=excluded.cached_tokens, token_based=excluded.token_based, cost_nanos=excluded.cost_nanos,
      body_json=excluded.body_json, updated_at=excluded.updated_at`)
      .run(entry.id, entry.provider, entry.externalId, entry.activity, entry.model, entry.status, entry.basis,
        entry.inputTokens, entry.outputTokens, entry.cachedTokens, entry.tokenBased ? 1 : 0,
        entry.costUsd === null ? null : Math.round(entry.costUsd * 1e9), canonicalJson(entry), entry.createdAt, now);
    return entry;
  }));

  const summary = (): UsageSummary => {
    const since = context.store.db.prepare("SELECT value_json FROM runtime_meta WHERE key='usage_started_at'").get() as { value_json: string };
    const rows = context.store.db.prepare(`SELECT activity, provider, model, COUNT(*) AS count,
      COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
      SUM(CASE WHEN token_based=1 AND status<>'pending' AND (input_tokens IS NULL OR output_tokens IS NULL) THEN 1 ELSE 0 END) AS missingTokens,
      SUM(CASE WHEN status<>'pending' AND basis='reported' THEN COALESCE(cost_nanos, 0) ELSE 0 END) AS reportedNanos,
      SUM(CASE WHEN (status='completed' OR input_tokens IS NOT NULL OR output_tokens IS NOT NULL) AND basis='estimated' THEN COALESCE(cost_nanos, 0) ELSE 0 END) AS estimatedNanos,
      SUM(CASE WHEN status<>'pending' AND (cost_nanos IS NULL OR (status<>'completed' AND input_tokens IS NULL AND output_tokens IS NULL AND basis='estimated')) THEN 1 ELSE 0 END) AS unpriced,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pendingCount,
      SUM(CASE WHEN status='pending' THEN COALESCE(cost_nanos, 0) ELSE 0 END) AS pendingNanos
      FROM runtime_usage GROUP BY activity, provider, model ORDER BY activity, provider, model`).all() as unknown as AggregateRow[];
    const groups: UsageGroup[] = rows.map(({ reportedNanos, estimatedNanos, pendingNanos, ...row }) => ({
      ...row, reportedUsd: reportedNanos / 1e9, estimatedUsd: estimatedNanos / 1e9, pendingUsd: pendingNanos / 1e9,
    }));
    const totals: UsageTotals = { count: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, missingTokens: 0, reportedUsd: 0, estimatedUsd: 0, unpriced: 0, pendingCount: 0, pendingUsd: 0 };
    for (const group of groups) {
      for (const key of Object.keys(totals) as Array<keyof UsageTotals>) totals[key] += group[key];
    }
    return { trackedSince: Number(since.value_json), currency: "USD", totals, groups };
  };

  const recent = (limit = 20): UsageEntry[] => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid("Usage limit must be between 1 and 200");
    const rows = context.store.db.prepare("SELECT body_json FROM runtime_usage ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as unknown as StoredRow[];
    return rows.flatMap((row) => { const entry = decode(row); return entry ? [entry] : []; });
  };

  return { record, read, find, summary, recent };
}
