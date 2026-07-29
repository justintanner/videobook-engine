import { readFile } from "node:fs/promises";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ENGINE_ERROR_CODES,
  MVP_CONTRACT_COMPATIBILITY,
  MVP_CONTRACT_FIXTURES,
  MVP_CONTRACT_FIXTURES_JSON,
  MVP_CONTRACT_VERSION,
  MVP_EDIT_OPERATION_KINDS,
  MVP_JOB_FAILURE_CODES,
  MVP_JOB_TYPES,
  MVP_SCHEMA_VERSION,
  canonicalContractJson,
  normalizeRational,
  normalizeSearchLocation,
  normalizeSequenceRange,
  normalizeSourcePoint,
  normalizeSourceRange,
  rationalEquals,
  sequenceFramesToSourceTicks,
  sequenceRangeEndFrame,
  sourceRangeEndTick,
  sourceTicksToSequenceFrames,
  type EditIntent,
  type SearchPage,
  type Sequence,
  type V4MigrationResult,
} from "../src/index.js";

describe("v17 MVP public contracts", () => {
  it("fixes one compatibility envelope without replacing v4 in place", () => {
    expect(MVP_CONTRACT_VERSION).toBe(1);
    expect(MVP_SCHEMA_VERSION).toBe(17);
    expect(MVP_CONTRACT_COMPATIBILITY).toEqual({
      contractVersion: 1,
      schemaVersion: 17,
      minimumReaderContractVersion: 1,
      legacySchemaVersions: [4, 5],
      legacyTimelineApi: "compile-to-sequence",
      legacySimilarityApi: "read-only-adapter",
    });
  });

  it("publishes every required P0 edit operation exactly once", () => {
    const fixtureKinds = MVP_CONTRACT_FIXTURES.editOperations.map(
      (operation) => operation.kind,
    );
    expect(fixtureKinds).toEqual(MVP_EDIT_OPERATION_KINDS);
    expect(new Set(fixtureKinds).size).toBe(MVP_EDIT_OPERATION_KINDS.length);
    expect(MVP_CONTRACT_FIXTURES.editPreview.operations).toHaveLength(
      MVP_EDIT_OPERATION_KINDS.length,
    );
    expect(
      MVP_CONTRACT_FIXTURES.editPreview.operations.map(
        (operation) => operation.ordinal,
      ),
    ).toEqual(Array.from({ length: MVP_EDIT_OPERATION_KINDS.length }, (_, index) => index));
  });

  it("keeps public fixture projections assignable to their exported types", () => {
    const intent: EditIntent = MVP_CONTRACT_FIXTURES.editIntent;
    const sequence: Sequence = MVP_CONTRACT_FIXTURES.sequence;
    const searchPage: SearchPage = MVP_CONTRACT_FIXTURES.searchPage;
    const migration: V4MigrationResult = MVP_CONTRACT_FIXTURES.migrationResult;

    expect(intent.sequenceId).toBe(sequence.sequenceId);
    expect(searchPage.hits[0]?.location.kind).toBe("timed");
    expect(migration.sourceSchemaVersion).toBe(4);
    expect(migration.destinationSchemaVersion).toBe(17);
  });

  it("pins the checked-in JSON fixture to the typed fixture", async () => {
    const raw = await readFile(
      new URL("../fixtures/v5/contract-fixtures.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    expect(canonicalContractJson(parsed)).toBe(MVP_CONTRACT_FIXTURES_JSON);
  });

  it("fixes job, failure, and engine error vocabularies", () => {
    expect(MVP_JOB_TYPES).toContain("final-render");
    expect(MVP_JOB_TYPES).toContain("embed-visual");
    expect(MVP_JOB_FAILURE_CODES).toEqual(
      expect.arrayContaining([
        "UNSUPPORTED_MEDIA",
        "MISSING_OBJECT",
        "MODEL_UNAVAILABLE",
        "OFFLINE",
        "RESOURCE_EXHAUSTED",
        "TIMEOUT",
        "CANCELLED",
        "INTERNAL_ERROR",
      ]),
    );
    expect(ENGINE_ERROR_CODES).toEqual(
      expect.arrayContaining(MVP_CONTRACT_FIXTURES.engineErrorCodes),
    );
  });
});

describe("rational and half-open media time", () => {
  it("normalizes positive rationals and compares equivalent values", () => {
    expect(normalizeRational({ numerator: 30_000, denominator: 1_000 })).toEqual({
      numerator: 30,
      denominator: 1,
    });
    expect(
      rationalEquals(
        { numerator: 30_000, denominator: 1_001 },
        { numerator: 60_000, denominator: 2_002 },
      ),
    ).toBe(true);
  });

  it("rejects invalid or unsafe persisted ranges", () => {
    expect(() =>
      normalizeSourceRange({
        streamId: "stream",
        objectHash: "hash",
        startTick: 0,
        durationTicks: 0,
        timeBase: { numerator: 1, denominator: 48_000 },
      }),
    ).toThrow("Source range duration");
    expect(() =>
      normalizeSequenceRange({
        sequenceId: "sequence",
        startFrame: -1,
        durationFrames: 1,
      }),
    ).toThrow("Sequence range start");
    expect(() =>
      normalizeSourcePoint({
        streamId: "stream",
        objectHash: "hash",
        tick: 1,
        timeBase: { numerator: 1, denominator: 0 },
      }),
    ).toThrow("Rational denominator");
    expect(() =>
      normalizeSourceRange({
        streamId: "stream",
        objectHash: "hash",
        startTick: Number.MAX_SAFE_INTEGER,
        durationTicks: 1,
        timeBase: { numerator: 1, denominator: 1 },
      }),
    ).toThrow("safe integer range");
  });

  it("uses half-open source, sequence, and UTF-8 document ranges", () => {
    expect(
      sourceRangeEndTick({
        streamId: "stream",
        objectHash: "hash",
        startTick: 100,
        durationTicks: 25,
        timeBase: { numerator: 1, denominator: 1_000 },
      }),
    ).toBe(125);
    expect(
      sequenceRangeEndFrame({
        sequenceId: "sequence",
        startFrame: 30,
        durationFrames: 15,
      }),
    ).toBe(45);
    expect(
      normalizeSearchLocation({
        kind: "document",
        artifactId: "artifact",
        sourcePath: "script.md",
        objectHash: "hash",
        startUtf8Byte: 4,
        endUtf8Byte: 9,
      }),
    ).toMatchObject({ startUtf8Byte: 4, endUtf8Byte: 9 });
    expect(() =>
      normalizeSearchLocation({
        kind: "document",
        artifactId: "artifact",
        sourcePath: "script.md",
        objectHash: "hash",
        startUtf8Byte: 9,
        endUtf8Byte: 9,
      }),
    ).toThrow("Document range duration");
  });

  it("round-trips exact frame boundaries without floating-point authority", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        (frames) => {
          const ticks = sequenceFramesToSourceTicks(
            frames,
            { numerator: 30, denominator: 1 },
            { numerator: 1, denominator: 30_000 },
          );
          expect(ticks).toBe(frames * 1_000);
          expect(
            sourceTicksToSequenceFrames(
              ticks,
              { numerator: 1, denominator: 30_000 },
              { numerator: 30, denominator: 1 },
            ),
          ).toBe(frames);
        },
      ),
    );
  });

  it("makes boundary rounding explicit", () => {
    expect(
      sourceTicksToSequenceFrames(
        1,
        { numerator: 1, denominator: 1_000 },
        { numerator: 30, denominator: 1 },
        "floor",
      ),
    ).toBe(0);
    expect(
      sourceTicksToSequenceFrames(
        1,
        { numerator: 1, denominator: 1_000 },
        { numerator: 30, denominator: 1 },
        "ceil",
      ),
    ).toBe(1);
  });
});

describe("canonical contract encoding", () => {
  it("sorts object keys recursively while retaining array order", () => {
    expect(
      canonicalContractJson({
        zebra: 1,
        alpha: { delta: 4, beta: 2 },
        list: [{ z: 1, a: 2 }, "last"],
      }),
    ).toBe(
      "{\"alpha\":{\"beta\":2,\"delta\":4},\"list\":[{\"a\":2,\"z\":1},\"last\"],\"zebra\":1}",
    );
  });
});
