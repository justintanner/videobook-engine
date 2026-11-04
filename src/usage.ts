import type { EngineContext } from "./context.js";
import { syncResultOf } from "./context.js";
import { canonicalJson, EngineFault, parseJson } from "./store.js";

export type UsageActualBasis = "stated" | "derived" | "usage-only" | "none";

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
  estimateUsd: number | null;
  estimateSource: string | null;
  estimateRateAsOf: string | null;
  actualBasis: UsageActualBasis | null;
  cacheWriteTokens: number | null;
  listUsd: number | null;
  notebookId: string | null;
  cellId: string | null;
  jobId: string | null;
  runId: string | null;
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

export interface UsageRollupTotals extends UsageTotals {
  // Known actual: stated or derived costs only. A quote still sitting in costUsd stays
  // out of this, though estimatedUsd counts that row, as it always has.
  actualUsd: number;
  // Quotes, not costs: estimatedUsd is unrelated. All rows; the rows behind actualUsd,
  // which is the pair to compare; and pending rows.
  estimateUsd: number;
  settledEstimateUsd: number;
  pendingEstimateUsd: number;
  // Rows with no settled actual, so a total is partial while this is above zero.
  unsettled: number;
  // Rows with no quote, so an estimate total understates while this is above zero.
  unestimated: number;
}

export interface UsageRollupGroup extends UsageRollupTotals {
  id: string;
}

export interface UsageRollupFilter {
  runId?: string;
  cellId?: string;
  jobId?: string;
}

export interface UsageRollup {
  currency: "USD";
  totals: UsageRollupTotals;
  runs: UsageRollupGroup[];
  cells: UsageRollupGroup[];
  jobs: UsageRollupGroup[];
}

type StoredRow = { body_json: string };
type TotalsRow = Omit<UsageTotals, "reportedUsd" | "estimatedUsd" | "pendingUsd"> & {
  reportedNanos: number;
  estimatedNanos: number;
  pendingNanos: number;
};
type AggregateRow = TotalsRow & Pick<UsageGroup, "activity" | "provider" | "model">;
type RollupRow = TotalsRow & Pick<UsageRollupTotals, "unsettled" | "unestimated"> & {
  actualNanos: number;
  estimateNanos: number;
  settledEstimateNanos: number;
  pendingEstimateNanos: number;
};
type AddedField = "estimateUsd" | "estimateSource" | "estimateRateAsOf" | "actualBasis" | "cacheWriteTokens" | "listUsd" | "notebookId" | "cellId" | "jobId" | "runId";

const activities = new Set(["images", "video", "audio", "chat", "voice", "analysis"]);
const statuses = new Set(["pending", "completed", "failed", "cancelled", "uncertain"]);
const bases = new Set(["reported", "estimated", "unknown", "free"]);
const actualBases = new Set(["stated", "derived", "usage-only", "none"]);
const rollupColumns = new Map([["runId", "run_id"], ["cellId", "cell_id"], ["jobId", "job_id"]]);

const unset: Pick<UsageEntry, AddedField> = {
  estimateUsd: null, estimateSource: null, estimateRateAsOf: null, actualBasis: null, cacheWriteTokens: null,
  listUsd: null, notebookId: null, cellId: null, jobId: null, runId: null,
};

const unpricedRow = "status<>'pending' AND (cost_nanos IS NULL OR (status<>'completed' AND input_tokens IS NULL AND output_tokens IS NULL AND basis='estimated'))";
const totalsColumns = `COUNT(*) AS count,
  COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
  COALESCE(SUM(CASE WHEN token_based=1 AND status<>'pending' AND (input_tokens IS NULL OR output_tokens IS NULL) THEN 1 ELSE 0 END), 0) AS missingTokens,
  COALESCE(SUM(CASE WHEN status<>'pending' AND basis='reported' THEN COALESCE(cost_nanos, 0) ELSE 0 END), 0) AS reportedNanos,
  COALESCE(SUM(CASE WHEN status<>'pending' AND (status='completed' OR input_tokens IS NOT NULL OR output_tokens IS NOT NULL) AND basis='estimated' THEN COALESCE(cost_nanos, 0) ELSE 0 END), 0) AS estimatedNanos,
  COALESCE(SUM(CASE WHEN ${unpricedRow} THEN 1 ELSE 0 END), 0) AS unpriced,
  COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END), 0) AS pendingCount,
  COALESCE(SUM(CASE WHEN status='pending' THEN COALESCE(cost_nanos, 0) ELSE 0 END), 0) AS pendingNanos`;
// An unlabelled row on the estimated basis counts only with token counts: older rows
// have no label, and a figure with tokens behind it came from usage, not from a quote.
const knownActualRow = `cost_nanos IS NOT NULL AND status<>'pending' AND (basis='reported' OR (basis='estimated'
  AND (status='completed' OR input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
  AND (actual_basis IN ('stated', 'derived') OR (actual_basis IS NULL AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)))))`;
const settledRow = `(${knownActualRow}) OR (basis='free' AND status<>'pending')`;
const rollupTotalsColumns = `${totalsColumns},
  COALESCE(SUM(CASE WHEN ${knownActualRow} THEN cost_nanos ELSE 0 END), 0) AS actualNanos,
  COALESCE(SUM(estimate_nanos), 0) AS estimateNanos,
  COALESCE(SUM(CASE WHEN ${settledRow} THEN COALESCE(estimate_nanos, 0) ELSE 0 END), 0) AS settledEstimateNanos,
  COALESCE(SUM(CASE WHEN status='pending' THEN COALESCE(estimate_nanos, 0) ELSE 0 END), 0) AS pendingEstimateNanos,
  COUNT(*) - COALESCE(SUM(CASE WHEN status NOT IN ('pending', 'uncertain') AND (${settledRow}) THEN 1 ELSE 0 END), 0) AS unsettled,
  COALESCE(SUM(CASE WHEN estimate_nanos IS NULL THEN 1 ELSE 0 END), 0) AS unestimated`;

function invalid(message: string): never {
  throw new EngineFault({ code: "INVALID_INPUT", message });
}

function validText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 500;
}

function validate(entry: UsageEntry): void {
  for (const name of ["id", "provider", "model"] as const) {
    if (!entry[name]?.trim() || entry[name].length > 500) invalid(`Invalid usage ${name}`);
  }
  for (const name of ["estimateSource", "estimateRateAsOf", "notebookId", "cellId", "jobId", "runId"] as const) {
    if (entry[name] !== null && !validText(entry[name])) invalid(`Invalid usage ${name}`);
  }
  if (!activities.has(entry.activity) || !statuses.has(entry.status) || !bases.has(entry.basis)) invalid("Invalid usage classification");
  if (entry.actualBasis !== null && !actualBases.has(entry.actualBasis)) invalid("Invalid usage classification");
  for (const name of ["inputTokens", "outputTokens", "cachedTokens", "cacheWriteTokens", "createdAt"] as const) {
    const n = entry[name];
    if (n !== null && (!Number.isSafeInteger(n) || n < 0)) invalid(`Invalid usage ${name}`);
  }
  if (entry.cachedTokens !== null && entry.inputTokens !== null && entry.cachedTokens > entry.inputTokens) invalid("Cached tokens exceed input tokens");
  for (const name of ["costUsd", "units", "estimateUsd", "listUsd"] as const) {
    const n = entry[name];
    if (n !== null && (!Number.isFinite(n) || n < 0)) invalid(`Invalid usage ${name}`);
  }
  for (const name of ["costUsd", "estimateUsd", "listUsd"] as const) {
    const n = entry[name];
    if (n !== null && !Number.isSafeInteger(Math.round(n * 1e9))) invalid("Usage cost exceeds precision limit");
  }
  if (entry.basis === "unknown") entry.costUsd = null;
  if (entry.basis === "free") entry.costUsd = 0;
  // A dropped figure takes its label with it: nothing is left to call stated or derived.
  if (entry.costUsd === null && (entry.actualBasis === "stated" || entry.actualBasis === "derived")) entry.actualBasis = null;
}

// How firmly a row or patch knows its cost: a charge the provider stated, then a figure
// derived from usage, then anything else. A weaker write cannot replace a stronger figure.
function actualRank(row: Pick<UsageInput, "basis" | "costUsd" | "actualBasis"> | null): number {
  if (!row || row.basis === "unknown" || row.basis === "free" || (row.costUsd ?? null) === null) return 0;
  if (row.actualBasis === "stated" || (row.basis === "reported" && !row.actualBasis)) return 2;
  return row.actualBasis === "derived" ? 1 : 0;
}

function toRollupTotals<T extends RollupRow>({ reportedNanos, estimatedNanos, pendingNanos, actualNanos, estimateNanos, settledEstimateNanos, pendingEstimateNanos, ...row }: T) {
  return {
    ...row,
    reportedUsd: reportedNanos / 1e9, estimatedUsd: estimatedNanos / 1e9, pendingUsd: pendingNanos / 1e9,
    actualUsd: actualNanos / 1e9, estimateUsd: estimateNanos / 1e9,
    settledEstimateUsd: settledEstimateNanos / 1e9, pendingEstimateUsd: pendingEstimateNanos / 1e9,
  };
}

export function createUsageApi(context: EngineContext) {
  // Read first: every engine constructs this, and a runtime transaction commits
  // even when its insert changes nothing, which would make each open a write.
  if (!context.store.db.prepare("SELECT 1 AS present FROM runtime_meta WHERE key='usage_started_at'").get()) {
    context.store.runtime((now) => {
      context.store.db.prepare("INSERT INTO runtime_meta(key, value_json, updated_at) VALUES ('usage_started_at', ?, ?) ON CONFLICT(key) DO NOTHING").run(String(now), now);
    });
  }

  const decode = (row: StoredRow | undefined): UsageEntry | null => {
    const entry = row ? parseJson<UsageEntry | null>(row.body_json, null) : null;
    return entry ? { ...unset, ...entry } : null;
  };
  const read = (id: string): UsageEntry | null => decode(context.store.db.prepare("SELECT body_json FROM runtime_usage WHERE id=?").get(id) as StoredRow | undefined);
  const find = (provider: string, externalId: string): UsageEntry | null => decode(context.store.db.prepare("SELECT body_json FROM runtime_usage WHERE provider=? AND external_id=?").get(provider, externalId) as StoredRow | undefined);

  const record = (input: UsageInput) => syncResultOf(() => context.store.runtime((now) => {
    const byId = read(input.id);
    const external = input.externalId ? find(input.provider, input.externalId) : null;
    const current = external ?? byId;
    const absorbed = external && byId && byId.id !== external.id ? byId : null;
    if (current && (current.provider !== input.provider || current.model !== input.model || current.activity !== input.activity)) invalid("Usage identity cannot change");
    const stale = current !== null && current.status !== "pending" && current.status !== "uncertain" && input.status === "pending";
    if (current && stale && !absorbed) return current;
    // A stale pending write cannot move a settled row. When it brings a row to absorb,
    // it can only fill in what that call knew: the quote and the attribution.
    const { id, provider, model, activity, estimateUsd, estimateSource, estimateRateAsOf, notebookId, cellId, jobId, runId } = input;
    const patch: UsageInput = stale ? { id, provider, model, activity, estimateUsd, estimateSource, estimateRateAsOf, notebookId, cellId, jobId, runId } : input;
    // A patch never clears these: null means "nothing new". A quote and its attribution
    // belong to the call that made them, so the first value stays; an actual may refine.
    const first = <K extends AddedField>(field: K) => (current?.[field] ?? absorbed?.[field] ?? patch[field] ?? null) as UsageEntry[K];
    const latest = <K extends AddedField>(field: K) => (patch[field] ?? current?.[field] ?? absorbed?.[field] ?? null) as UsageEntry[K];
    const quote = [current, absorbed, patch].find((row) => typeof row?.estimateUsd === "number");
    const entry: UsageEntry = {
      status: "pending", basis: "unknown", externalId: null,
      inputTokens: null, outputTokens: null, cachedTokens: null, tokenBased: false,
      costUsd: null, units: null, unit: null, rateSource: null, pricingVersion: null,
      artifactId: null, operation: null, warnings: [], createdAt: now,
      ...current, ...patch, id: current?.id ?? input.id, updatedAt: now,
      estimateUsd: quote ? quote.estimateUsd ?? null : latest("estimateUsd"),
      estimateSource: quote ? quote.estimateSource ?? null : latest("estimateSource"),
      estimateRateAsOf: quote ? quote.estimateRateAsOf ?? null : latest("estimateRateAsOf"),
      actualBasis: latest("actualBasis"), cacheWriteTokens: latest("cacheWriteTokens"), listUsd: latest("listUsd"),
      notebookId: first("notebookId"), cellId: first("cellId"), jobId: first("jobId"), runId: first("runId"),
    };
    if (current) entry.createdAt = current.createdAt;
    const held = actualRank(absorbed) > actualRank(current) ? absorbed : current;
    if (held && actualRank(held) > actualRank(patch)) {
      entry.costUsd = held.costUsd;
      entry.basis = held.basis;
      entry.rateSource = held.rateSource;
      entry.actualBasis = held.actualBasis;
      entry.listUsd = held.listUsd;
    } else if (!patch.actualBasis && actualRank(patch) > actualRank(held)) {
      entry.actualBasis = null;
    }
    validate(entry);
    if (absorbed) context.store.db.prepare("DELETE FROM runtime_usage WHERE id=?").run(absorbed.id);
    context.store.db.prepare(`INSERT INTO runtime_usage
      (id, provider, external_id, activity, model, status, basis, input_tokens, output_tokens, cached_tokens, token_based, cost_nanos, estimate_nanos, actual_basis, run_id, cell_id, job_id, body_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id, status=excluded.status,
      basis=excluded.basis, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      cached_tokens=excluded.cached_tokens, token_based=excluded.token_based, cost_nanos=excluded.cost_nanos,
      estimate_nanos=excluded.estimate_nanos, actual_basis=excluded.actual_basis, run_id=excluded.run_id, cell_id=excluded.cell_id, job_id=excluded.job_id,
      body_json=excluded.body_json, updated_at=excluded.updated_at`)
      .run(entry.id, entry.provider, entry.externalId, entry.activity, entry.model, entry.status, entry.basis,
        entry.inputTokens, entry.outputTokens, entry.cachedTokens, entry.tokenBased ? 1 : 0,
        entry.costUsd === null ? null : Math.round(entry.costUsd * 1e9),
        entry.estimateUsd === null ? null : Math.round(entry.estimateUsd * 1e9),
        entry.actualBasis, entry.runId, entry.cellId, entry.jobId, canonicalJson(entry), entry.createdAt, now);
    return entry;
  }));

  const summary = (): UsageSummary => {
    const since = context.store.db.prepare("SELECT value_json FROM runtime_meta WHERE key='usage_started_at'").get() as { value_json: string };
    const rows = context.store.db.prepare(`SELECT activity, provider, model, ${totalsColumns}
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

  const rollup = (filter: UsageRollupFilter = {}): UsageRollup => {
    const terms: string[] = [];
    const params: string[] = [];
    for (const [key, value] of Object.entries(filter)) {
      const column = rollupColumns.get(key);
      if (!column || !validText(value)) invalid(`Invalid usage rollup filter ${key}`);
      terms.push(`${column}=?`);
      params.push(value as string);
    }
    const groups = (column: string): UsageRollupGroup[] => {
      const rows = context.store.db.prepare(`SELECT ${column} AS id, ${rollupTotalsColumns} FROM runtime_usage
        WHERE ${[...terms, `${column} IS NOT NULL`].join(" AND ")} GROUP BY ${column} ORDER BY ${column}`).all(...params) as unknown as Array<RollupRow & { id: string }>;
      return rows.map(toRollupTotals);
    };
    const totals = context.store.db.prepare(`SELECT ${rollupTotalsColumns} FROM runtime_usage
      ${terms.length > 0 ? `WHERE ${terms.join(" AND ")}` : ""}`).get(...params) as unknown as RollupRow;
    return { currency: "USD", totals: toRollupTotals(totals), runs: groups("run_id"), cells: groups("cell_id"), jobs: groups("job_id") };
  };

  const recent = (limit = 20): UsageEntry[] => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid("Usage limit must be between 1 and 200");
    const rows = context.store.db.prepare("SELECT body_json FROM runtime_usage ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as unknown as StoredRow[];
    return rows.flatMap((row) => { const entry = decode(row); return entry ? [entry] : []; });
  };

  const interrupted = context.store.db.prepare("SELECT body_json FROM runtime_usage WHERE status='pending' AND (external_id IS NULL OR activity='voice')").all() as unknown as StoredRow[];
  for (const row of interrupted) {
    const entry = decode(row);
    if (entry) record({ ...entry, status: "uncertain", basis: "unknown", warnings: ["Provider outcome unavailable after restart"] });
  }

  return { record, read, find, summary, rollup, recent };
}
