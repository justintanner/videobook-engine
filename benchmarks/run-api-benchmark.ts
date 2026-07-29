import { writeFile } from "node:fs/promises";
import * as path from "node:path";

import {
  quickApiBenchmarkOptions,
  runFullApiBenchmark,
  type ApiBenchmarkOperation,
  type ApiBenchmarkOptions,
  type ApiBenchmarkReport,
} from "./api-benchmark.js";

interface CliOptions {
  benchmark: Partial<ApiBenchmarkOptions>;
  json: boolean;
  output?: string;
}
const options = parseArgs(process.argv.slice(2));
const report = await runFullApiBenchmark(options.benchmark);

if (options.output) {
  const outputPath = path.resolve(options.output);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.json) console.log(`Report written to ${outputPath}`);
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
}

function parseArgs(args: string[]): CliOptions {
  const benchmark: Partial<ApiBenchmarkOptions> = {};
  let json = false;
  let output: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--quick") {
      Object.assign(benchmark, quickApiBenchmarkOptions());
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--retain-fixture") {
      benchmark.retainFixture = true;
    } else if (arg === "--artifacts") {
      benchmark.artifactCount = positiveInteger(args[++index], arg);
    } else if (arg === "--moments") {
      benchmark.momentCount = positiveInteger(args[++index], arg);
    } else if (arg === "--reads") {
      benchmark.readIterations = positiveInteger(args[++index], arg);
    } else if (arg === "--output") {
      output = requiredValue(args[++index], arg);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { benchmark, json, ...(output ? { output } : {}) };
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(requiredValue(value, flag));
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printReport(report: ApiBenchmarkReport): void {
  console.log(
    `Full API benchmark: ${formatMs(report.durationMs)} wall, `
      + `${formatMs(report.measuredMs)} measured`,
  );
  console.log(
    `Workload: ${report.workload.artifactCount} artifacts, `
      + `${report.workload.momentCount} moments, `
      + `${report.workload.readIterations} read iterations`,
  );
  console.log(
    `Coverage: ${report.coverage.observedGroups.length}/`
      + `${report.coverage.expectedGroups.length} API groups`,
  );
  console.log("");
  console.log(
    "Operation".padEnd(40)
      + "samples".padStart(9)
      + "total".padStart(12)
      + "mean".padStart(12)
      + "p50".padStart(12)
      + "p95".padStart(12)
      + "share".padStart(9),
  );
  for (const operation of report.operations) printOperation(operation);
  console.log("");
  console.log(
    `80% frontier: ${report.pareto.operationCount}/`
      + `${report.pareto.totalOperationCount} operations `
      + `(${formatPercent(report.pareto.operationShare)} of operations) `
      + `account for ${formatPercent(report.pareto.capturedTimeShare)} `
      + "of measured time.",
  );
  for (const name of report.pareto.operations) console.log(`- ${name}`);
  if (report.fixtureRoot) {
    console.log(`Fixture retained at ${report.fixtureRoot}`);
  }
}

function printOperation(operation: ApiBenchmarkOperation): void {
  console.log(
    operation.name.padEnd(40)
      + String(operation.samples).padStart(9)
      + formatMs(operation.totalMs).padStart(12)
      + formatMs(operation.meanMs).padStart(12)
      + formatMs(operation.p50Ms).padStart(12)
      + formatMs(operation.p95Ms).padStart(12)
      + formatPercent(operation.totalShare).padStart(9),
  );
}

function formatMs(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}s`;
  if (value >= 10) return `${value.toFixed(1)}ms`;
  return `${value.toFixed(2)}ms`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printHelp(): void {
  console.log(`Usage: npm run benchmark:api -- [options]

Options:
  --quick             Minimal smoke workload
  --artifacts <n>     Number of seeded artifacts (minimum 4)
  --moments <n>       Number of temporal-search moments
  --reads <n>         Read-path repetitions
  --json              Print the complete report as JSON
  --output <path>     Write the complete JSON report to a file
  --retain-fixture    Keep the generated engine root for inspection
  -h, --help          Show this help`);
}
