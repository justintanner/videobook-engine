import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const TEMPORAL_CACHE_FORMAT = "usearch-2.26.0-cos-f16-16-128-128-v2";

interface TemporalIndexSnapshot {
  format: string;
  identity: string;
  dimensions: number;
  graph: string;
  graphHash: string;
  entries: Array<[string, string]>;
}

export function vectorDigest(vector: Float32Array): string {
  return createHash("sha256").update(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)).digest("hex");
}

export function readTemporalIndexSnapshot(basePath: string, identity: string, dimensions: number): TemporalIndexSnapshot | undefined {
  try {
    const snapshot = JSON.parse(readFileSync(`${basePath}.json`, "utf8")) as TemporalIndexSnapshot;
    if (snapshot.format !== TEMPORAL_CACHE_FORMAT || snapshot.identity !== identity || snapshot.dimensions !== dimensions
      || !Array.isArray(snapshot.entries) || !/^[a-f0-9]{64}$/.test(snapshot.graphHash)
      || snapshot.graph !== `${basename(basePath)}-${snapshot.graphHash}.usearch`) return undefined;
    const keys = new Set<string>();
    for (const entry of snapshot.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string"
        || typeof entry[1] !== "string" || !/^[a-f0-9]{64}$/.test(entry[1]) || keys.has(entry[0])) return undefined;
      keys.add(entry[0]);
    }
    const graph = readFileSync(join(dirname(basePath), snapshot.graph));
    if (createHash("sha256").update(graph).digest("hex") !== snapshot.graphHash) return undefined;
    return snapshot;
  } catch { return undefined; }
}

export function saveTemporalIndexSnapshot(
  basePath: string, identity: string, dimensions: number, entries: Array<[string, string]>,
  saveGraph: (path: string) => void,
): void {
  mkdirSync(dirname(basePath), { recursive: true });
  const suffix = randomUUID();
  const temporaryGraph = `${basePath}-${suffix}.tmp`;
  const temporaryMetadata = `${basePath}-${suffix}.json.tmp`;
  let priorGraph: string | undefined;
  try {
    const prior = JSON.parse(readFileSync(`${basePath}.json`, "utf8")) as TemporalIndexSnapshot;
    if (prior.graph === `${basename(basePath)}-${prior.graphHash}.usearch` && /^[a-f0-9]{64}$/.test(prior.graphHash)) priorGraph = prior.graph;
  } catch { /* A damaged cache is replaced from the committed vectors. */ }
  try {
    saveGraph(temporaryGraph);
    const graphHash = createHash("sha256").update(readFileSync(temporaryGraph)).digest("hex");
    const graph = `${basename(basePath)}-${graphHash}.usearch`;
    renameSync(temporaryGraph, join(dirname(basePath), graph));
    const snapshot: TemporalIndexSnapshot = { format: TEMPORAL_CACHE_FORMAT, identity, dimensions, graph, graphHash, entries };
    writeFileSync(temporaryMetadata, `${JSON.stringify(snapshot)}\n`);
    renameSync(temporaryMetadata, `${basePath}.json`);
    if (priorGraph && priorGraph !== graph) rmSync(join(dirname(basePath), priorGraph), { force: true });
  } finally {
    rmSync(temporaryGraph, { force: true });
    rmSync(temporaryMetadata, { force: true });
  }
}
