import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEngine,
  type Engine,
  type SimilarityEmbeddingProvider,
  type SimilarityTextEmbeddingProvider,
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

const textProvider: SimilarityTextEmbeddingProvider = {
  embeddingSpace: "text-test-v1",
  dimensions: 4,
  async prepare() {},
  async embedText(text) {
    const chunks: Array<{
      startOffset: number;
      endOffset: number;
      vector: Float32Array;
    }> = [];
    for (let startOffset = 0; startOffset < text.length; startOffset += 96) {
      const endOffset = Math.min(text.length, startOffset + 96);
      chunks.push({
        startOffset,
        endOffset,
        vector: textVector(text.slice(startOffset, endOffset)),
      });
    }
    return chunks;
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

describe("text similarity API", () => {
  it("indexes JSON, Markdown, and text in one project-scoped pool", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-text-sim-"));
    roots.push(root);
    let engine: Engine | null = createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      similarity: { provider, text: { provider: textProvider } },
    });
    try {
      const project = value(await engine.projects.create("text"));
      const otherProject = value(await engine.projects.create("other-text"));
      const markdown = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "script",
        slug: "cat-markdown",
      }));
      const plain = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "character",
        slug: "feline-plain",
      }));
      const json = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "prompt",
        slug: "cat-json",
      }));
      const unrelated = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "final",
        slug: "ocean-final",
      }));
      const otherProjectCat = value(await engine.artifacts.create({
        project: otherProject.projectId,
        kind: "script",
        slug: "other-cat",
      }));

      value(await engine.files.write(
        markdown.artifactId,
        "original.md",
        "# Scene\n\nA cat sits on a warm rug.\n\nThe cat watches quietly.",
        project.projectId,
      ));
      value(await engine.files.write(
        plain.artifactId,
        "original.txt",
        "A feline lounges on a woven mat.",
        project.projectId,
      ));
      value(await engine.files.write(
        json.artifactId,
        "original.json",
        '{"surface":"rug","subject":"cat","mood":"calm"}',
        project.projectId,
      ));
      value(await engine.files.write(
        unrelated.artifactId,
        "original.txt",
        "A boat sails across the ocean.",
        project.projectId,
      ));
      value(await engine.files.write(
        otherProjectCat.artifactId,
        "original.md",
        "A cat sits on a warm rug.",
        otherProject.projectId,
      ));

      expect(value(await engine.similarity.prepare({ kind: "text" }))).toMatchObject({
        embeddingSpace: "test-v1",
        embeddingSpaces: { text: "text-test-v1" },
      });

      const indexResults = await Promise.all([
        markdown,
        plain,
        json,
        unrelated,
        otherProjectCat,
      ].map((artifact) => engine!.similarity.index(
        artifact.projectId,
        artifact.artifactId,
      )));
      expect(indexResults.map(value).every((result) => result.kind === "text"))
        .toBe(true);
      expect(value(engine.similarity.status(project.projectId, json.artifactId)))
        .toMatchObject({ kind: "text", state: "ready", chunkCount: 1 });
      expect(value(engine.similarity.stats(project.projectId))).toMatchObject({
        imageCount: 0,
        videoCount: 0,
        textCount: 4,
        embeddingSpaces: { text: "text-test-v1" },
      });
      expect(value(await engine.similarity.rebuild(project.projectId, { kind: "text" })))
        .toHaveLength(4);

      const rawMatches = value(await engine.similarity.findSimilarText(
        project.projectId,
        "cat rug",
        { minScore: 0.5, limit: 10 },
      ));
      expect(rawMatches.map((match) => match.artifactId)).toEqual(
        expect.arrayContaining([
          markdown.artifactId,
          plain.artifactId,
          json.artifactId,
        ]),
      );
      expect(rawMatches.map((match) => match.artifactId))
        .not.toContain(unrelated.artifactId);
      expect(rawMatches.map((match) => match.artifactId))
        .not.toContain(otherProjectCat.artifactId);
      expect(rawMatches[0]).toMatchObject({
        kind: "text",
        text: {
          sourcePath: expect.stringMatching(/original\.(md|txt|json)$/),
          excerpt: expect.any(String),
          startOffset: expect.any(Number),
          endOffset: expect.any(Number),
        },
      });

      const artifactMatches = value(await engine.similarity.findSimilar(
        project.projectId,
        markdown.artifactId,
        { minScore: 0.5, limit: 10 },
      ));
      expect(artifactMatches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: plain.artifactId,
            exactBytes: false,
            text: expect.objectContaining({ excerpt: expect.any(String) }),
          }),
          expect.objectContaining({ artifactId: json.artifactId }),
        ]),
      );
      expect(artifactMatches.map((match) => match.artifactId))
        .not.toContain(markdown.artifactId);

      engine.close();
      engine = createEngine({
        dataDir: path.join(root, "data"),
        workspaceDir: path.join(root, "workspace"),
        similarity: { provider, text: { provider: textProvider } },
      });
      const afterRestart = value(await engine.similarity.findSimilarText(
        project.projectId,
        "cat rug",
        { minScore: 0.5 },
      ));
      expect(afterRestart.map((match) => match.artifactId)).toEqual(
        expect.arrayContaining([markdown.artifactId, json.artifactId]),
      );
    } finally {
      engine?.close();
    }
  });

  it("normalizes JSON for content exactness and reuses compatible chunks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-text-exact-"));
    roots.push(root);
    const engine = createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      similarity: { provider, text: { provider: textProvider } },
    });
    try {
      const project = value(await engine.projects.create("exact-text"));
      const first = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "scene",
        slug: "first-json",
      }));
      const reordered = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "scene",
        slug: "reordered-json",
      }));
      const byteExact = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "scene",
        slug: "byte-exact-json",
      }));
      const jsonA = '{"b":"rug","a":"cat"}';
      const jsonB = '{\n  "a": "cat",\n  "b": "rug"\n}';
      for (const [artifact, jsonText] of [
        [first, jsonA],
        [reordered, jsonB],
        [byteExact, jsonA],
      ] as const) {
        value(await engine.files.write(
          artifact.artifactId,
          "original.json",
          jsonText,
          project.projectId,
        ));
      }
      expect(value(await engine.similarity.index(
        project.projectId,
        first.artifactId,
      )).reused).toBe(false);
      expect(value(await engine.similarity.index(
        project.projectId,
        reordered.artifactId,
      )).reused).toBe(true);
      expect(value(await engine.similarity.index(
        project.projectId,
        byteExact.artifactId,
      )).reused).toBe(true);
      expect(value(await engine.similarity.index(
        project.projectId,
        first.artifactId,
        { force: true },
      )).reused).toBe(false);

      const matches = value(await engine.similarity.findSimilar(
        project.projectId,
        first.artifactId,
        { limit: 10 },
      ));
      expect(matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: reordered.artifactId,
            exactBytes: false,
            exactContent: true,
            score: 1,
          }),
          expect.objectContaining({
            artifactId: byteExact.artifactId,
            exactBytes: true,
            exactContent: true,
            score: 1,
          }),
        ]),
      );
    } finally {
      engine.close();
    }
  });

  it("rejects malformed or ambiguous text sources and reports disabled text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-text-errors-"));
    roots.push(root);
    const engine = createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      similarity: { provider, text: { provider: textProvider, maxSourceBytes: 8 } },
    });
    try {
      const project = value(await engine.projects.create("text-errors"));
      const invalid = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "prompt",
        slug: "invalid-json",
      }));
      value(await engine.files.write(
        invalid.artifactId,
        "original.json",
        "{oops",
        project.projectId,
      ));
      expect(await engine.similarity.index(project.projectId, invalid.artifactId))
        .toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });

      const invalidUtf8 = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "prompt",
        slug: "invalid-utf8",
      }));
      value(await engine.files.write(
        invalidUtf8.artifactId,
        "original.txt",
        Buffer.from([0xff, 0xfe]),
        project.projectId,
      ));
      expect(await engine.similarity.index(project.projectId, invalidUtf8.artifactId))
        .toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });

      const empty = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "character",
        slug: "empty-text",
      }));
      value(await engine.files.write(
        empty.artifactId,
        "original.md",
        "\n\n  \n",
        project.projectId,
      ));
      expect(await engine.similarity.index(project.projectId, empty.artifactId))
        .toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });

      const tooLarge = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "script",
        slug: "too-large",
      }));
      value(await engine.files.write(
        tooLarge.artifactId,
        "original.md",
        "123456789",
        project.projectId,
      ));
      expect(await engine.similarity.index(project.projectId, tooLarge.artifactId))
        .toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });

      const ambiguous = value(await engine.artifacts.create({
        project: project.projectId,
        kind: "notebook",
        slug: "ambiguous",
      }));
      value(await engine.files.write(
        ambiguous.artifactId,
        "original.md",
        "cat",
        project.projectId,
      ));
      value(await engine.files.write(
        ambiguous.artifactId,
        "original.txt",
        "cat",
        project.projectId,
      ));
      expect(await engine.similarity.index(project.projectId, ambiguous.artifactId))
        .toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    } finally {
      engine.close();
    }

    const disabled = createEngine({
      dataDir: path.join(root, "disabled-data"),
      workspaceDir: path.join(root, "disabled-workspace"),
    });
    try {
      expect(await disabled.similarity.findSimilarText("missing", "cat"))
        .toMatchObject({ ok: false, error: { code: "FEATURE_UNAVAILABLE" } });
    } finally {
      disabled.close();
    }
  });
});

function vectorFor(content: string): Float32Array {
  if (content.startsWith("cat variant")) return new Float32Array([0.98, 0.2, 0]);
  if (content.startsWith("cat")) return new Float32Array([1, 0, 0]);
  return new Float32Array([0, 1, 0]);
}

function textVector(content: string): Float32Array {
  const lower = content.toLocaleLowerCase();
  const cat = lower.includes("cat") || lower.includes("feline");
  const rug = lower.includes("rug") || lower.includes("mat");
  const ocean = lower.includes("ocean") || lower.includes("boat");
  const calm = lower.includes("calm") || lower.includes("quiet");
  const vector = new Float32Array([
    cat ? 1 : 0,
    rug ? 1 : 0,
    ocean ? 1 : 0,
    calm ? 1 : 0,
  ]);
  if (vector.every((value) => value === 0)) vector[3] = 1;
  return vector;
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
