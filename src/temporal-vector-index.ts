import { createRequire } from "node:module";

type Usearch = typeof import("usearch");
let usearch: Usearch | undefined;

interface Entry<T> {
  key: string;
  vector: Float32Array;
  value: T;
  ordinal: number;
}

export class TemporalVectorIndex<T> {
  readonly entries = new Map<string, Entry<T>>();
  private readonly ordinals = new Map<number, Entry<T>>();
  private nextOrdinal = 1;
  private index?: InstanceType<Usearch["Index"]>;

  constructor(readonly dimensions: number) {}

  set(key: string, vector: Float32Array, value: T): void {
    this.delete(key);
    const entry = { key, vector, value, ordinal: this.nextOrdinal++ };
    this.entries.set(key, entry);
    this.ordinals.set(entry.ordinal, entry);
    this.index?.add(BigInt(entry.ordinal), vector, 1);
  }

  delete(key: string): void {
    const prior = this.entries.get(key);
    if (!prior) return;
    this.index?.remove(BigInt(prior.ordinal));
    this.entries.delete(key);
    this.ordinals.delete(prior.ordinal);
  }

  nearest(
    query: Float32Array,
    count: number,
    eligible: ReadonlyMap<string, unknown>,
  ): Array<{ value: T; score: number; key: string }> {
    if (query.length !== this.dimensions || !query.every(Number.isFinite)) {
      throw new Error("Query vector must contain finite values with the index dimensions");
    }
    if (query.every((value) => value === 0)) {
      return [...eligible.keys()].filter((key) => this.entries.has(key)).sort().slice(0, count)
        .map((key) => ({ key, value: this.entries.get(key)!.value, score: 0 }));
    }
    let entries: Entry<T>[];
    if (eligible.size <= count) {
      entries = [...eligible.keys()].flatMap((key) => {
        const entry = this.entries.get(key);
        return entry ? [entry] : [];
      });
    } else if (this.entries.size <= count) {
      entries = [...this.entries.values()].filter((entry) => eligible.has(entry.key));
    } else {
      const index = this.nativeIndex();
      let requested = Math.min(this.entries.size, count * 2);
      for (;;) {
        entries = [...index.search(query, requested, 1).keys].flatMap((ordinal) => {
          const entry = this.ordinals.get(Number(ordinal));
          return entry && eligible.has(entry.key) ? [entry] : [];
        });
        if (entries.length >= count || requested === this.entries.size) break;
        requested = Math.min(this.entries.size, requested * 2);
      }
    }
    return entries.map((entry) => ({ key: entry.key, value: entry.value, score: cosine(query, entry.vector) }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
      .slice(0, count);
  }

  private nativeIndex(): InstanceType<Usearch["Index"]> {
    if (this.index) return this.index;
    usearch ??= createRequire(import.meta.url)("usearch") as Usearch;
    const index = new usearch.Index({
      dimensions: this.dimensions, metric: usearch.MetricKind.Cos,
      quantization: usearch.ScalarKind.F16, connectivity: 16,
      expansion_add: 128, expansion_search: 128, multi: false,
    });
    for (const entry of this.entries.values()) index.add(BigInt(entry.ordinal), entry.vector, 1);
    this.index = index;
    return index;
  }
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}
