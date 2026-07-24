import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  artifactSlug,
  computeArtifactStatus,
  createEngine,
  normalizeKind,
  type Engine,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("artifact slug prefixes", () => {
  it("does not expose notebook as an artifact kind or prefix", async () => {
    expect(() => normalizeKind("notebook")).toThrow("Invalid artifact kind");
    expect(() => artifactSlug("script", "book-story-notes")).not.toThrow();
    const engine = await setup();
    try {
      expect(await engine.artifacts.create({ kind: "notebook", name: "notes" })).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    } finally {
      engine.close();
    }
  });

  it.each([
    ["prompt", "Draft", "prompt-draft"],
    ["scene", "Opening Shot", "scene-opening-shot"],
    ["script", "Story Notes", "script-story-notes"],
  ] as const)("uses the canonical %s prefix", (kind, name, expected) => {
    expect(artifactSlug(kind, name)).toBe(expected);
    expect(artifactSlug(kind, expected)).toBe(expected);
  });

  it.each([
    ["prompt", "prm-draft"],
    ["scene", "scn-opening-shot"],
    ["script", "char-story-notes"],
  ] as const)("rejects the legacy prefix for new %s slugs", (kind, slug) => {
    expect(() => artifactSlug(kind, slug)).toThrow(
      `Artifact slug ${slug} does not match kind ${kind}`,
    );
  });

  it("classifies the canonical non-media prefixes as ready", () => {
    for (const artifactSlug of [
      "prompt-draft",
      "scene-opening-shot",
      "char-story-notes",
    ]) {
      expect(
        computeArtifactStatus({
          artifactSlug,
          fileNames: new Set(),
          primaryMediaName: null,
          hasOriginalMetadata: false,
          hasPartFile: false,
          lockData: null,
          pendingTask: null,
          generationError: null,
          artifactRow: null,
        }),
      ).toBe("ready");
    }
  });

  it("resolves unqualified tags using the canonical prefixes", async () => {
    const engine = await setup();
    try {
      const artifacts = await Promise.all([
        engine.artifacts.create({
          kind: "prompt",
          name: "main prompt",
        }),
        engine.artifacts.create({
          kind: "scene",
          name: "opening shot",
        }),
        engine.artifacts.create({
          kind: "script",
          name: "story notes",
        }),
      ]);
      artifacts.forEach(value);

      const resolution = value(
        await engine.resolver.resolveAll(
          "@main-prompt @opening-shot @story-notes",
        ),
      );

      expect(resolution.unresolved).toEqual([]);
      expect(
        resolution.resolved.map((artifact) => artifact.artifactSlug),
      ).toEqual([
        "prompt-main-prompt",
        "scene-opening-shot",
        "script-story-notes",
      ]);
    } finally {
      engine.close();
    }
  });
});

async function setup(): Promise<Engine> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-prefixes-"));
  roots.push(root);
  return createEngine({
    dataDir: path.join(root, "data"),
    workspaceDir: path.join(root, "workspace"),
    initialBookSlug: "prefixes",
  });
}

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
