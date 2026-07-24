import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  artifactSlug,
  computeArtifactStatus,
  createEngine,
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
  it.each([
    ["prompt", "Draft", "prompt-draft"],
    ["scene", "Opening Shot", "scene-opening-shot"],
    ["notebook", "Story Notes", "book-story-notes"],
  ] as const)("uses the canonical %s prefix", (kind, name, expected) => {
    expect(artifactSlug(kind, name)).toBe(expected);
    expect(artifactSlug(kind, expected)).toBe(expected);
  });

  it.each([
    ["prompt", "prm-draft"],
    ["scene", "scn-opening-shot"],
    ["notebook", "nb-story-notes"],
  ] as const)("rejects the legacy prefix for new %s slugs", (kind, slug) => {
    expect(() => artifactSlug(kind, slug)).toThrow(
      `Artifact slug ${slug} does not match kind ${kind}`,
    );
  });

  it("classifies the canonical non-media prefixes as ready", () => {
    for (const artifactSlug of [
      "prompt-draft",
      "scene-opening-shot",
      "book-story-notes",
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
      const project = value(await engine.projects.create("prefixes"));
      const artifacts = await Promise.all([
        engine.artifacts.create({
          project: project.projectId,
          kind: "prompt",
          name: "main prompt",
        }),
        engine.artifacts.create({
          project: project.projectId,
          kind: "scene",
          name: "opening shot",
        }),
        engine.artifacts.create({
          project: project.projectId,
          kind: "notebook",
          name: "story notes",
        }),
      ]);
      artifacts.forEach(value);

      const resolution = value(
        await engine.resolver.resolveAll(
          "@main-prompt @opening-shot @story-notes",
          project.projectId,
        ),
      );

      expect(resolution.unresolved).toEqual([]);
      expect(
        resolution.resolved.map((artifact) => artifact.artifactSlug),
      ).toEqual([
        "prompt-main-prompt",
        "scene-opening-shot",
        "book-story-notes",
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
