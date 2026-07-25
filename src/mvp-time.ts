export interface Rational {
  numerator: number;
  denominator: number;
}

export interface SourceRange {
  streamId: string;
  objectHash: string;
  startTick: number;
  durationTicks: number;
  timeBase: Rational;
}

export interface SourcePoint {
  streamId: string;
  objectHash: string;
  tick: number;
  timeBase: Rational;
}

export type MediaSourceSnapshot =
  | {
      kind: "still";
      artifactId: string;
      sourcePath: string;
      objectHash: string;
    }
  | {
      kind: "timed";
      artifactId: string;
      range: SourceRange;
    };

export type SearchLocation =
  | MediaSourceSnapshot
  | {
      kind: "document";
      artifactId: string;
      sourcePath: string;
      objectHash: string;
      startUtf8Byte: number;
      endUtf8Byte: number;
    };

export interface SequenceRange {
  sequenceId: string;
  startFrame: number;
  durationFrames: number;
}

export type RationalRounding = "floor" | "nearest" | "ceil";

export function normalizeRational(value: Rational): Rational {
  assertSafePositiveInteger(value.numerator, "Rational numerator");
  assertSafePositiveInteger(value.denominator, "Rational denominator");
  const divisor = greatestCommonDivisor(value.numerator, value.denominator);
  return {
    numerator: value.numerator / divisor,
    denominator: value.denominator / divisor,
  };
}

export function rationalEquals(left: Rational, right: Rational): boolean {
  const normalizedLeft = normalizeRational(left);
  const normalizedRight = normalizeRational(right);
  return normalizedLeft.numerator === normalizedRight.numerator
    && normalizedLeft.denominator === normalizedRight.denominator;
}

export function rationalToNumber(value: Rational): number {
  const normalized = normalizeRational(value);
  return normalized.numerator / normalized.denominator;
}

export function sourceRangeEndTick(range: SourceRange): number {
  const normalized = normalizeSourceRange(range);
  return checkedSum(
    normalized.startTick,
    normalized.durationTicks,
    "Source range end",
  );
}

export function sequenceRangeEndFrame(range: SequenceRange): number {
  const normalized = normalizeSequenceRange(range);
  return checkedSum(
    normalized.startFrame,
    normalized.durationFrames,
    "Sequence range end",
  );
}

export function normalizeSourcePoint(point: SourcePoint): SourcePoint {
  assertIdentifier(point.streamId, "Source stream ID");
  assertIdentifier(point.objectHash, "Source object hash");
  assertSafeNonNegativeInteger(point.tick, "Source point tick");
  return {
    ...point,
    timeBase: normalizeRational(point.timeBase),
  };
}

export function normalizeSourceRange(range: SourceRange): SourceRange {
  assertIdentifier(range.streamId, "Source stream ID");
  assertIdentifier(range.objectHash, "Source object hash");
  assertSafeNonNegativeInteger(range.startTick, "Source range start");
  assertSafePositiveInteger(range.durationTicks, "Source range duration");
  checkedSum(range.startTick, range.durationTicks, "Source range end");
  return {
    ...range,
    timeBase: normalizeRational(range.timeBase),
  };
}

export function normalizeSequenceRange(range: SequenceRange): SequenceRange {
  assertIdentifier(range.sequenceId, "Sequence ID");
  assertSafeNonNegativeInteger(range.startFrame, "Sequence range start");
  assertSafePositiveInteger(range.durationFrames, "Sequence range duration");
  checkedSum(range.startFrame, range.durationFrames, "Sequence range end");
  return { ...range };
}

export function normalizeSearchLocation(location: SearchLocation): SearchLocation {
  assertIdentifier(location.artifactId, "Artifact ID");
  if (location.kind === "timed") {
    return {
      ...location,
      range: normalizeSourceRange(location.range),
    };
  }
  assertIdentifier(location.sourcePath, "Source path");
  assertIdentifier(location.objectHash, "Source object hash");
  if (location.kind === "document") {
    assertSafeNonNegativeInteger(location.startUtf8Byte, "Document range start");
    assertSafePositiveInteger(
      location.endUtf8Byte - location.startUtf8Byte,
      "Document range duration",
    );
    assertSafeNonNegativeInteger(location.endUtf8Byte, "Document range end");
  }
  return { ...location };
}

export function sourceTicksToSequenceFrames(
  ticks: number,
  timeBase: Rational,
  frameRate: Rational,
  rounding: RationalRounding = "nearest",
): number {
  assertSafeNonNegativeInteger(ticks, "Source ticks");
  const normalizedTimeBase = normalizeRational(timeBase);
  const normalizedFrameRate = normalizeRational(frameRate);
  return roundedRatio(
    BigInt(ticks)
      * BigInt(normalizedTimeBase.numerator)
      * BigInt(normalizedFrameRate.numerator),
    BigInt(normalizedTimeBase.denominator)
      * BigInt(normalizedFrameRate.denominator),
    rounding,
  );
}

export function sequenceFramesToSourceTicks(
  frames: number,
  frameRate: Rational,
  timeBase: Rational,
  rounding: RationalRounding = "nearest",
): number {
  assertSafeNonNegativeInteger(frames, "Sequence frames");
  const normalizedFrameRate = normalizeRational(frameRate);
  const normalizedTimeBase = normalizeRational(timeBase);
  return roundedRatio(
    BigInt(frames)
      * BigInt(normalizedFrameRate.denominator)
      * BigInt(normalizedTimeBase.denominator),
    BigInt(normalizedFrameRate.numerator)
      * BigInt(normalizedTimeBase.numerator),
    rounding,
  );
}

export function canonicalContractJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RangeError(`${label} must not be empty`);
  }
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertSafePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function checkedSum(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return result;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function roundedRatio(
  numerator: bigint,
  denominator: bigint,
  rounding: RationalRounding,
): number {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  let result = quotient;
  if (rounding === "ceil" && remainder > 0n) result += 1n;
  if (rounding === "nearest" && remainder * 2n >= denominator) result += 1n;
  const numeric = Number(result);
  if (!Number.isSafeInteger(numeric)) {
    throw new RangeError("Rational conversion exceeds the safe integer range");
  }
  return numeric;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
