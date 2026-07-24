import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEngine,
  type Engine,
  type SimilarityEmbeddingProvider,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

const provider: SimilarityEmbeddingProvider = {
  embeddingSpace: "test-v1",
  dimensions: 3,
  async prepare() {},
  async embedImage(sourcePath) {
    return vectorFor(await readFile(sourcePath, "utf8"));
  },
  async embedVideo(sourcePath) {
    return { vector: vectorFor(await readFile(sourcePath, "utf8")), frameCount: 1 };
  },
};

describe("local similarity API", () => {
  it("keeps media kinds and projects isolated while preserving runtime embeddings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-sim-unit-"));
    roots.push(root);
    let engine: Engine | null = createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      similarity: { provider },
    });
    try {
      const project = value(await engine.projects.create("alpha"));
      const otherProject = value(await engine.projects.create("beta"));
      const cat = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "image",
        slug: "img-cat",
      }));
      const catVariant = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "image",
        slug: "img-cat-variant",
      }));
      const video = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "video",
        slug: "vid-cat",
      }));
      const otherCat = value(await engine.artifacts.create({
        project: otherProject.projectId,
        kind: "image",
        slug: "img-cat-other-project",
      }));

      value(await engine.files.write(cat.artifactId, "original.jpg", "cat", project.projectId));
      value(await engine.files.write(
        catVariant.artifactId,
        "original.jpg",
        "cat variant",
        project.projectId,
      ));
      value(await engine.files.write(video.artifactId, "original.mp4", "cat", project.projectId));
      value(await engine.files.write(
        otherCat.artifactId,
        "original.jpg",
        "cat",
        otherProject.projectId,
      ));

      expect(value(engine.similarity.status(project.projectId, cat.artifactId)).state)
        .toBe("not_indexed");
      const notReady = await engine.similarity.findSimilar(project.projectId, cat.artifactId);
      expect(notReady).toMatchObject({ ok: false, error: { code: "NOT_READY" } });

      for (const artifact of [cat, catVariant, video]) {
        value(await engine.similarity.index(project.projectId, artifact.artifactId));
      }
      value(await engine.similarity.index(otherProject.projectId, otherCat.artifactId));

      const matches = value(await engine.similarity.findSimilar(
        project.projectId,
        cat.artifactId,
      ));
      expect(matches).toEqual([
        expect.objectContaining({
          artifactId: catVariant.artifactId,
          kind: "image",
          exactBytes: false,
        }),
      ]);
      expect(value(engine.similarity.stats(project.projectId))).toMatchObject({
        imageCount: 2,
        videoCount: 1,
      });

      engine.close();
      engine = createEngine({
        dataDir: path.join(root, "data"),
        workspaceDir: path.join(root, "workspace"),
        similarity: { provider },
      });
      const afterRestart = value(await engine.similarity.findSimilar(
        project.projectId,
        cat.artifactId,
      ));
      expect(afterRestart[0]?.artifactId).toBe(catVariant.artifactId);
    } finally {
      engine?.close();
    }
  });

  it("reports a disabled feature without changing ordinary engines", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-sim-disabled-"));
    roots.push(root);
    const engine = createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
    });
    try {
      expect(await engine.similarity.prepare()).toMatchObject({
        ok: false,
        error: { code: "FEATURE_UNAVAILABLE" },
      });
    } finally {
      engine.close();
    }
  });
});

function vectorFor(content: string): Float32Array {
  if (content.startsWith("cat variant")) return new Float32Array([0.98, 0.2, 0]);
  if (content.startsWith("cat")) return new Float32Array([1, 0, 0]);
  return new Float32Array([0, 1, 0]);
}

function value<T>(result: {
  ok: true;
  value: T;
} | {
  ok: false;
  error: { code: string; message: string };
}): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

async function removeRoot(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 1 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}
