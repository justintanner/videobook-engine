import type {
  SearchBenchmarkCase,
  SearchBenchmarkCaseResult,
  SearchBenchmarkClass,
  SearchBenchmarkClassMetrics,
  SearchBenchmarkReport,
  SearchHit,
  SearchPage,
} from "./mvp-contracts.js";
import type { SourceRange } from "./mvp-time.js";

const CLASSES: SearchBenchmarkClass[] = [
  "natural-language-visual",
  "quoted-speech-ocr",
  "reverse-image-exact",
  "reverse-image-semantic",
  "reverse-video",
  "audio",
];

const RECALL_THRESHOLDS: Partial<Record<SearchBenchmarkClass, number>> = {
  "natural-language-visual": 0.8,
  "quoted-speech-ocr": 0.95,
  "reverse-image-semantic": 0.85,
  "reverse-video": 0.75,
  audio: 0.8,
};

export async function evaluateSearchBenchmark(
  corpusVersion: string,
  manifestIds: string[],
  cases: SearchBenchmarkCase[],
  search: (item: SearchBenchmarkCase) => Promise<SearchPage>,
): Promise<SearchBenchmarkReport> {
  const caseResults: SearchBenchmarkCaseResult[] = [];
  for (const item of cases) {
    const started = performance.now();
    const page = await search(item);
    const latencyMs = performance.now() - started;
    const hits = page.hits.slice(0, 5);
    const relevant = hits.filter((hit) =>
      item.judgments.some((judgment) => hitMatches(hit, judgment)),
    );
    const boundaryErrors = hits.flatMap((hit) =>
      item.judgments.flatMap((judgment) => {
        const error = boundaryErrorMs(hit, judgment.range);
        return error === undefined ? [] : [error];
      }),
    );
    caseResults.push({
      caseId: item.caseId,
      class: item.class,
      latencyMs,
      recallAt5:
        item.judgments.length === 0
          ? 0
          : Math.min(1, relevant.length / item.judgments.length),
      top1Correct:
        page.hits[0] !== undefined
        && item.judgments.some((judgment) =>
          hitMatches(page.hits[0]!, judgment),
        ),
      ...(boundaryErrors.length > 0
        ? { boundaryErrorMs: Math.min(...boundaryErrors) }
        : {}),
    });
  }
  const classes = CLASSES.flatMap((className) => {
    const values = caseResults.filter((item) => item.class === className);
    return values.length === 0 ? [] : [classMetrics(className, values)];
  });
  const latencies = caseResults.map((item) => item.latencyMs);
  const boundaryErrors = caseResults.flatMap((item) =>
    item.boundaryErrorMs === undefined ? [] : [item.boundaryErrorMs],
  );
  const latencyP50Ms = percentile(latencies, 0.5);
  const latencyP95Ms = percentile(latencies, 0.95);
  const medianBoundaryErrorMs =
    boundaryErrors.length > 0 ? percentile(boundaryErrors, 0.5) : undefined;
  const failures = reportFailures(
    classes,
    latencyP50Ms,
    latencyP95Ms,
    medianBoundaryErrorMs,
  );
  return {
    corpusVersion,
    manifestIds: [...manifestIds].sort(),
    caseResults,
    classes,
    latencyP50Ms,
    latencyP95Ms,
    ...(medianBoundaryErrorMs === undefined ? {} : { medianBoundaryErrorMs }),
    passed: failures.length === 0,
    failures,
  };
}

export function compareSearchBenchmarks(
  baseline: SearchBenchmarkReport,
  candidate: SearchBenchmarkReport,
  maximumRegression = 0.05,
): string[] {
  const failures: string[] = [];
  for (const current of candidate.classes) {
    const prior = baseline.classes.find((item) => item.class === current.class);
    if (!prior) continue;
    if (prior.recallAt5 - current.recallAt5 > maximumRegression) {
      failures.push(
        `${current.class} recall@5 regressed by ${(prior.recallAt5 - current.recallAt5).toFixed(3)}`,
      );
    }
    if (prior.top1Accuracy - current.top1Accuracy > maximumRegression) {
      failures.push(
        `${current.class} top-1 regressed by ${(prior.top1Accuracy - current.top1Accuracy).toFixed(3)}`,
      );
    }
  }
  return failures;
}

function classMetrics(
  className: SearchBenchmarkClass,
  values: SearchBenchmarkCaseResult[],
): SearchBenchmarkClassMetrics {
  return {
    class: className,
    caseCount: values.length,
    recallAt5:
      values.reduce((sum, item) => sum + item.recallAt5, 0) / values.length,
    top1Accuracy:
      values.filter((item) => item.top1Correct).length / values.length,
  };
}

function hitMatches(
  hit: SearchHit,
  judgment: { artifactId: string; range?: SourceRange },
): boolean {
  if (hit.artifactId !== judgment.artifactId) return false;
  if (!judgment.range) return true;
  if (hit.location.kind !== "timed") return false;
  const range = hit.location.range;
  if (range.streamId !== judgment.range.streamId) return false;
  return (
    range.startTick < judgment.range.startTick + judgment.range.durationTicks
    && judgment.range.startTick < range.startTick + range.durationTicks
  );
}

function boundaryErrorMs(
  hit: SearchHit,
  judgment: SourceRange | undefined,
): number | undefined {
  if (!judgment || hit.location.kind !== "timed") return undefined;
  const range = hit.location.range;
  if (range.streamId !== judgment.streamId) return undefined;
  const startError = Math.abs(range.startTick - judgment.startTick);
  const endError = Math.abs(
    range.startTick
      + range.durationTicks
      - judgment.startTick
      - judgment.durationTicks,
  );
  return (
    ((startError + endError) / 2)
    * judgment.timeBase.numerator
    * 1_000
    / judgment.timeBase.denominator
  );
}

function reportFailures(
  classes: SearchBenchmarkClassMetrics[],
  latencyP50Ms: number,
  latencyP95Ms: number,
  medianBoundaryErrorMs: number | undefined,
): string[] {
  const failures: string[] = [];
  for (const metrics of classes) {
    const threshold = RECALL_THRESHOLDS[metrics.class];
    if (threshold !== undefined && metrics.recallAt5 < threshold) {
      failures.push(
        `${metrics.class} recall@5 ${metrics.recallAt5.toFixed(3)} is below ${threshold.toFixed(2)}`,
      );
    }
    if (
      metrics.class === "reverse-image-exact"
      && metrics.top1Accuracy < 0.95
    ) {
      failures.push(
        `reverse-image-exact top-1 ${metrics.top1Accuracy.toFixed(3)} is below 0.95`,
      );
    }
  }
  if (latencyP50Ms >= 500) failures.push("Warm search p50 is not under 500 ms");
  if (latencyP95Ms >= 1_500) failures.push("Warm search p95 is not under 1.5 s");
  if (medianBoundaryErrorMs !== undefined && medianBoundaryErrorMs >= 1_000) {
    failures.push("Median boundary error is not under 1.0 s");
  }
  return failures;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index]!;
}
