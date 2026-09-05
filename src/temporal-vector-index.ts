import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";

import { EngineFault } from "./store.js";
import { readTemporalIndexSnapshot, saveTemporalIndexSnapshot, vectorDigest } from "./temporal-index-cache.js";

type Usearch = typeof import("usearch");
let usearch: Usearch | undefined;
const DIRECT_VECTOR_LIMIT = 1_000;
const CHECKPOINT_CHANGES = 5_000;

interface Entry<T> {
  key: string;
  vector: Float32Array;
  value: T;
  ordinal: bigint;
  digest: string;
}

interface VectorPreparationResult {
  vectors: number;
  updatedVectors: number;
  loaded: boolean;
  persisted: boolean;
}

export class TemporalVectorIndex<T> {
  readonly entries = new Map<string, Entry<T>>();
  private readonly ordinals = new Map<bigint, Entry<T>>();
  private index?: InstanceType<Usearch["Index"]>;
  private nativeEntries = new Map<string, string>();
  private revision = 0;
  private changesSinceCheckpoint = 0;
  private prepareTask?: Promise<VectorPreparationResult>;
  private disposed = false;

  constructor(readonly dimensions: number, private readonly cache: { basePath: string; identity: string }) {}

  set(key: string, vector: Float32Array, value: T): void {
    const ordinal = keyOrdinal(key);
    const occupied = this.ordinals.get(ordinal);
    if (occupied && occupied.key !== key) throw new Error("Temporal vector key hash collision");
    const entry = { key, vector, value, ordinal, digest: vectorDigest(vector) };
    if (this.index && this.nativeEntries.get(key) !== entry.digest) {
      try {
        if (this.nativeEntries.has(key)) this.index.remove(ordinal);
        this.index.add(ordinal, vector, 1);
      } catch (error) {
        this.index = undefined;
        this.nativeEntries.clear();
        throw error;
      }
      this.nativeEntries.set(key, entry.digest);
    }
    this.entries.set(key, entry);
    this.ordinals.set(ordinal, entry);
    this.revision++;
    this.changesSinceCheckpoint++;
  }

  delete(key: string): void {
    const prior = this.entries.get(key);
    if (!prior) return;
    // Keep native slots occupied: loading a USearch snapshot with removed slots
    // and then adding vectors can corrupt native memory. Queries filter inactive keys.
    this.entries.delete(key);
    this.ordinals.delete(prior.ordinal);
    this.revision++;
    this.changesSinceCheckpoint++;
  }

  prepare(signal?: AbortSignal, periodic = false): Promise<VectorPreparationResult> {
    if (this.prepareTask) return this.prepareTask;
    const task = this.prepareIndex(signal, periodic);
    this.prepareTask = task;
    void task.finally(() => { this.prepareTask = undefined; }).catch(() => {});
    return task;
  }

  checkpoint(periodic = false): boolean {
    if (!this.index || this.changesSinceCheckpoint === 0
      || (periodic && this.changesSinceCheckpoint < CHECKPOINT_CHANGES)) return false;
    saveTemporalIndexSnapshot(this.cache.basePath, this.cache.identity, this.dimensions,
      [...this.nativeEntries], (path) => this.index!.save(path));
    this.changesSinceCheckpoint = 0;
    return true;
  }

  dispose(): void {
    this.disposed = true;
    try { this.checkpoint(); }
    finally { this.index = undefined; this.nativeEntries.clear(); this.entries.clear(); this.ordinals.clear(); }
  }

  nearest(query: Float32Array, count: number, eligible: ReadonlyMap<string, unknown>): Array<{ value: T; score: number; key: string }> {
    if (query.length !== this.dimensions || !query.every(Number.isFinite)) throw new Error("Query vector must contain finite values with the index dimensions");
    if (query.every((value) => value === 0)) {
      return [...eligible.keys()].filter((key) => this.entries.has(key)).sort().slice(0, count)
        .map((key) => ({ key, value: this.entries.get(key)!.value, score: 0 }));
    }
    let entries: Entry<T>[];
    if (eligible.size <= DIRECT_VECTOR_LIMIT) {
      entries = [...eligible.keys()].flatMap((key) => {
        const entry = this.entries.get(key);
        return entry ? [entry] : [];
      });
    } else if (this.entries.size <= DIRECT_VECTOR_LIMIT) {
      entries = [...this.entries.values()].filter((entry) => eligible.has(entry.key));
    } else {
      const index = this.readyIndex();
      let requested = Math.min(this.nativeEntries.size, count * 2);
      for (;;) {
        entries = [...index.search(query, requested, 1).keys].flatMap((ordinal) => {
          const entry = this.ordinals.get(ordinal);
          return entry && eligible.has(entry.key) ? [entry] : [];
        });
        if (entries.length >= count || requested === this.nativeEntries.size) break;
        requested = Math.min(this.nativeEntries.size, requested * 2);
      }
    }
    return entries.map((entry) => ({ key: entry.key, value: entry.value, score: cosine(query, entry.vector) }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key)).slice(0, count);
  }

  private readyIndex(): InstanceType<Usearch["Index"]> {
    if (this.index) return this.index;
    if (!this.prepareTask) {
      const loaded = this.loadSnapshot();
      if (loaded && [...this.entries.values()].every((entry) => loaded.entries.get(entry.key) === entry.digest)) {
        this.index = loaded.index;
        this.nativeEntries = loaded.entries;
        this.changesSinceCheckpoint = 0;
        return this.index;
      }
    }
    throw new EngineFault({ code: "NOT_READY", message: "Temporal search index requires preparation",
      details: { requiresIndexPreparation: true } });
  }

  private async prepareIndex(signal: AbortSignal | undefined, periodic: boolean): Promise<VectorPreparationResult> {
    this.checkCancellation(signal);
    if (this.entries.size <= DIRECT_VECTOR_LIMIT && !this.index) return { vectors: this.entries.size, updatedVectors: 0, loaded: false, persisted: false };
    if (this.index && !this.needsCompaction(this.nativeEntries)) {
      return { vectors: this.entries.size, updatedVectors: 0, loaded: false, persisted: this.checkpoint(periodic) };
    }
    const candidate = this.index ? undefined : this.loadSnapshot();
    const loaded = candidate && !this.needsCompaction(candidate.entries) ? candidate : undefined;
    const index = loaded?.index ?? newNativeIndex(this.dimensions);
    const prepared = loaded?.entries ?? new Map<string, string>();
    let updatedVectors = 0;
    for (;;) {
      const revision = this.revision;
      let work = 0;
      for (const entry of [...this.entries.values()]) {
        if (prepared.get(entry.key) === entry.digest) continue;
        if (prepared.has(entry.key)) index.remove(entry.ordinal);
        index.add(entry.ordinal, entry.vector, 1);
        prepared.set(entry.key, entry.digest);
        updatedVectors++;
        if (++work % 32 === 0) { await yieldTurn(); this.checkCancellation(signal); }
      }
      this.checkCancellation(signal);
      if (revision === this.revision) break;
    }
    this.index = index;
    this.nativeEntries = prepared;
    this.changesSinceCheckpoint = updatedVectors || (loaded ? 0 : Math.max(1, this.entries.size));
    const persisted = this.checkpoint(!loaded ? false : periodic);
    return { vectors: this.entries.size, updatedVectors, loaded: Boolean(loaded), persisted };
  }

  private needsCompaction(prepared: ReadonlyMap<string, string>): boolean {
    let inactive = 0;
    for (const key of prepared.keys()) if (!this.entries.has(key)) inactive++;
    return inactive > prepared.size / 4;
  }

  private loadSnapshot(): { index: InstanceType<Usearch["Index"]>; entries: Map<string, string> } | undefined {
    const snapshot = readTemporalIndexSnapshot(this.cache.basePath, this.cache.identity, this.dimensions);
    if (!snapshot) return undefined;
    try {
      const index = newNativeIndex(this.dimensions);
      index.load(join(dirname(this.cache.basePath), snapshot.graph));
      if (index.dimensions() !== this.dimensions || index.size() !== snapshot.entries.length
        || !(index.contains(snapshot.entries.map(([key]) => keyOrdinal(key))) as boolean[]).every(Boolean)) return undefined;
      return { index, entries: new Map(snapshot.entries) };
    } catch { return undefined; }
  }

  private checkCancellation(signal?: AbortSignal): void {
    if (signal?.aborted || this.disposed) throw new EngineFault({ code: "CANCELLED", message: "Temporal index preparation cancelled" });
  }
}

function keyOrdinal(key: string): bigint { return createHash("sha256").update(key).digest().readBigUInt64LE(); }

function newNativeIndex(dimensions: number): InstanceType<Usearch["Index"]> {
  usearch ??= createRequire(import.meta.url)("usearch") as Usearch;
  return new usearch.Index({ dimensions, metric: usearch.MetricKind.Cos, quantization: usearch.ScalarKind.F16,
    connectivity: 16, expansion_add: 128, expansion_search: 128, multi: false });
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}
