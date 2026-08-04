import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEngine,
  type Engine,
  type SimilarityAudioEmbeddingProvider,
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

const audioProvider: SimilarityAudioEmbeddingProvider = {
  embeddingSpace: "audio-test-v1",
  dimensions: 3,
  async prepare() {},
  async embedAudio(sourcePath) {
    return audioVector(await readFile(sourcePath, "utf8"));
  },
};

describe("local similarity API", () => {
  it("indexes one book-wide media pool and preserves runtime embeddings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-sim-unit-"));
    roots.push(root);
    let engine: Engine | null = createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "media",
      similarity: { provider },
    });
    try {
      const cat = value(
        await engine.artifacts.create({ kind: "image", label: "img-cat" }),
      );
      const catVariant = value(
        await engine.artifacts.create({ kind: "image", label: "img-cat-variant" }),
      );
      const catExact = value(
        await engine.artifacts.create({ kind: "image", label: "img-cat-exact" }),
      );
      const video = value(
        await engine.artifacts.create({ kind: "video", label: "vid-cat" }),
      );
      value(await engine.files.write(cat.artifactId, "original.jpg", "cat"));
      value(await engine.files.write(catVariant.artifactId, "original.jpg", "cat variant"));
      value(await engine.files.write(catExact.artifactId, "original.jpg", "cat"));
      value(await engine.files.write(video.artifactId, "original.mp4", "cat"));

      expect(value(engine.similarity.status(cat.artifactId)).state).toBe("not_indexed");
      expect(await engine.similarity.findSimilar(cat.artifactId)).toMatchObject({
        ok: false,
        error: { code: "NOT_READY" },
      });
      for (const artifact of [cat, catVariant, catExact, video]) {
        value(await engine.similarity.index(artifact.artifactId));
      }
      const matches = value(await engine.similarity.findSimilar(cat.artifactId));
      expect(matches[0]).toMatchObject({
        artifactId: catExact.artifactId,
        kind: "image",
        exactBytes: true,
        score: 1,
      });
      expect(matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: catVariant.artifactId,
            kind: "image",
            exactBytes: false,
          }),
        ]),
      );
      expect(value(engine.similarity.stats())).toMatchObject({
        imageCount: 3,
        videoCount: 1,
      });

      engine.close();
      engine = createEngine({
        dataDir: path.join(root, "data"),
        workspaceDir: path.join(root, "workspace"),
        similarity: { provider },
      });
      expect(value(await engine.similarity.findSimilar(cat.artifactId))[0]?.artifactId).toBe(
        catExact.artifactId,
      );
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
      initialBookName: "disabled",
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

describe("audio similarity API", () => {
  it("indexes audio in a separate book-wide pool and persists embeddings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-audio-sim-"));
    roots.push(root);
    let engine: Engine | null = createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "audio",
      similarity: { provider, audio: { provider: audioProvider } },
    });
    try {
      const purr = value(
        await engine.artifacts.create({ kind: "audio", label: "aud-purr" }),
      );
      const purrVariant = value(
        await engine.artifacts.create({ kind: "audio", label: "aud-purr-variant" }),
      );
      const purrExact = value(
        await engine.artifacts.create({ kind: "audio", label: "aud-purr-exact" }),
      );
      const rain = value(
        await engine.artifacts.create({ kind: "audio", label: "aud-rain" }),
      );
      value(await engine.files.write(purr.artifactId, "original.mp3", "purr"));
      value(
        await engine.files.write(
          purrVariant.artifactId,
          "original.wav",
          "purr variant",
        ),
      );
      value(await engine.files.write(purrExact.artifactId, "original.flac", "purr"));
      value(await engine.files.write(rain.artifactId, "original.m4a", "rain"));

      expect(value(await engine.similarity.prepare({ kind: "audio" }))).toMatchObject({
        embeddingSpaces: { audio: "audio-test-v1" },
      });
      expect(value(engine.similarity.status(purr.artifactId))).toMatchObject({
        kind: "audio",
        state: "not_indexed",
        embeddingSpace: "audio-test-v1",
      });
      expect(await engine.similarity.findSimilar(purr.artifactId)).toMatchObject({
        ok: false,
        error: { code: "NOT_READY" },
      });

      expect(value(await engine.similarity.index(purr.artifactId)).reused).toBe(false);
      expect(value(await engine.similarity.index(purrVariant.artifactId)).reused).toBe(false);
      expect(value(await engine.similarity.index(purrExact.artifactId)).reused).toBe(true);
      expect(value(await engine.similarity.index(rain.artifactId)).reused).toBe(false);

      const matches = value(
        await engine.similarity.findSimilar(purr.artifactId, { limit: 10 }),
      );
      expect(matches[0]).toMatchObject({
        artifactId: purrExact.artifactId,
        kind: "audio",
        exactBytes: true,
        score: 1,
      });
      expect(matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: purrVariant.artifactId,
            kind: "audio",
            exactBytes: false,
          }),
        ]),
      );
      expect(value(engine.similarity.stats())).toMatchObject({
        audioCount: 4,
        embeddingSpaces: { audio: "audio-test-v1" },
      });
      expect(value(await engine.similarity.rebuild({ kind: "audio" }))).toHaveLength(4);

      engine.close();
      engine = createEngine({
        dataDir: path.join(root, "data"),
        workspaceDir: path.join(root, "workspace"),
        similarity: { provider, audio: { provider: audioProvider } },
      });
      expect(
        value(await engine.similarity.findSimilar(purr.artifactId))[0]?.artifactId,
      ).toBe(purrExact.artifactId);
    } finally {
      engine?.close();
    }
  });

  it("requires audio configuration and a canonical original audio file", async () => {
    const disabledRoot = await mkdtemp(
      path.join(tmpdir(), "videobook-audio-disabled-"),
    );
    roots.push(disabledRoot);
    const disabled = createEngine({
      dataDir: path.join(disabledRoot, "data"),
      workspaceDir: path.join(disabledRoot, "workspace"),
      initialBookName: "audio-disabled",
      similarity: { provider },
    });
    try {
      const audio = value(
        await disabled.artifacts.create({ kind: "audio", label: "aud-disabled" }),
      );
      value(await disabled.files.write(audio.artifactId, "original.mp3", "purr"));
      expect(await disabled.similarity.index(audio.artifactId)).toMatchObject({
        ok: false,
        error: { code: "FEATURE_UNAVAILABLE" },
      });
    } finally {
      disabled.close();
    }

    const invalidRoot = await mkdtemp(
      path.join(tmpdir(), "videobook-audio-invalid-"),
    );
    roots.push(invalidRoot);
    const invalid = createEngine({
      dataDir: path.join(invalidRoot, "data"),
      workspaceDir: path.join(invalidRoot, "workspace"),
      initialBookName: "audio-invalid",
      similarity: { provider, audio: { provider: audioProvider } },
    });
    try {
      const audio = value(
        await invalid.artifacts.create({ kind: "audio", label: "aud-invalid" }),
      );
      value(await invalid.files.write(audio.artifactId, "track.mp3", "purr"));
      expect(await invalid.similarity.index(audio.artifactId)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    } finally {
      invalid.close();
    }
  });

  it("uses the v4 audio-capable runtime schema without an upgrade path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-audio-upgrade-"));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const workspaceDir = path.join(root, "workspace");
    let engine: Engine | null = createEngine({
      dataDir,
      workspaceDir,
      initialBookName: "audio-upgrade",
      similarity: { provider },
    });
    let imageId: string;
    try {
      const image = value(
        await engine.artifacts.create({ kind: "image", label: "img-preserved" }),
      );
      imageId = image.artifactId;
      value(await engine.files.write(imageId, "original.jpg", "cat"));
      value(await engine.similarity.index(imageId));
    } finally {
      engine.close();
      engine = null;
    }

    const catalog = new DatabaseSync(path.join(dataDir, "videobook.db"));
    try {
      const table = catalog
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type='table' AND name='runtime_similarity_embeddings'`,
        )
        .get() as { sql: string };
      expect(table.sql).toContain("'audio'");
      expect(
        catalog
          .prepare(
            `SELECT 1 AS present FROM sqlite_master
             WHERE type='table' AND name='runtime_engine_leases'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      catalog.close();
    }

    engine = createEngine({
      dataDir,
      workspaceDir,
      similarity: { provider, audio: { provider: audioProvider } },
    });
    try {
      expect(value(engine.similarity.status(imageId!))).toMatchObject({
        state: "ready",
        kind: "image",
      });
      const audio = value(
        await engine.artifacts.create({ kind: "audio", label: "aud-after-upgrade" }),
      );
      value(await engine.files.write(audio.artifactId, "original.mp3", "purr"));
      expect(value(await engine.similarity.index(audio.artifactId))).toMatchObject({
        kind: "audio",
      });
      expect(value(engine.similarity.stats())).toMatchObject({
        imageCount: 1,
        audioCount: 1,
      });
    } finally {
      engine.close();
    }
  });
});

describe("text similarity API", () => {
  it("indexes JSON, Markdown, and text in the book-wide pool", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-text-sim-"));
    roots.push(root);
    let engine: Engine | null = createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "text",
      similarity: { provider, text: { provider: textProvider } },
    });
    try {
      const markdown = value(
        await engine.artifacts.create({ kind: "script", label: "script-cat-markdown" }),
      );
      const plain = value(
        await engine.artifacts.create({ kind: "character", label: "char-feline-plain" }),
      );
      const json = value(
        await engine.artifacts.create({ kind: "prompt", label: "prompt-cat-json" }),
      );
      const unrelated = value(
        await engine.artifacts.create({ kind: "final", label: "final" }),
      );
      value(
        await engine.files.write(
          markdown.artifactId,
          "original.md",
          "# Scene\n\nA cat sits on a warm rug.",
        ),
      );
      value(await engine.files.write(plain.artifactId, "original.txt", "A feline lounges on a mat."));
      value(
        await engine.files.write(
          json.artifactId,
          "original.json",
          '{"surface":"rug","subject":"cat","mood":"calm"}',
        ),
      );
      value(await engine.files.write(unrelated.artifactId, "original.txt", "A boat sails across the ocean."));

      expect(value(await engine.similarity.prepare({ kind: "text" }))).toMatchObject({
        embeddingSpaces: { text: "text-test-v1" },
      });
      for (const artifact of [markdown, plain, json, unrelated]) {
        expect(value(await engine.similarity.index(artifact.artifactId)).kind).toBe("text");
      }
      expect(value(engine.similarity.status(json.artifactId))).toMatchObject({
        kind: "text",
        state: "ready",
        chunkCount: 1,
      });
      expect(value(engine.similarity.stats())).toMatchObject({ textCount: 4 });
      expect(value(await engine.similarity.rebuild({ kind: "text" }))).toHaveLength(4);

      const rawMatches = value(await engine.similarity.findSimilarText("cat rug", { minScore: 0.5 }));
      expect(rawMatches.map((match) => match.artifactId)).toEqual(
        expect.arrayContaining([markdown.artifactId, json.artifactId]),
      );
      const artifactMatches = value(
        await engine.similarity.findSimilar(markdown.artifactId, { limit: 10 }),
      );
      expect(artifactMatches.map((match) => match.artifactId)).toEqual(
        expect.arrayContaining([plain.artifactId, json.artifactId]),
      );

      engine.close();
      engine = createEngine({
        dataDir: path.join(root, "data"),
        workspaceDir: path.join(root, "workspace"),
        similarity: { provider, text: { provider: textProvider } },
      });
      expect(
        value(await engine.similarity.findSimilarText("cat rug", { minScore: 0.5 }))
          .map((match) => match.artifactId),
      ).toEqual(expect.arrayContaining([markdown.artifactId, json.artifactId]));
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
      initialBookName: "exact-text",
      similarity: { provider, text: { provider: textProvider } },
    });
    try {
      const first = value(
        await engine.artifacts.create({ kind: "scene", label: "scene-first-json" }),
      );
      const reordered = value(
        await engine.artifacts.create({ kind: "scene", label: "scene-reordered-json" }),
      );
      const byteExact = value(
        await engine.artifacts.create({ kind: "scene", label: "scene-byte-exact-json" }),
      );
      const jsonA = '{"b":"rug","a":"cat"}';
      const jsonB = '{\n  "a": "cat",\n  "b": "rug"\n}';
      for (const [artifact, contents] of [
        [first, jsonA],
        [reordered, jsonB],
        [byteExact, jsonA],
      ] as const) {
        value(await engine.files.write(artifact.artifactId, "original.json", contents));
      }
      expect(value(await engine.similarity.index(first.artifactId)).reused).toBe(false);
      expect(value(await engine.similarity.index(reordered.artifactId)).reused).toBe(true);
      expect(value(await engine.similarity.index(byteExact.artifactId)).reused).toBe(true);
      const matches = value(await engine.similarity.findSimilar(first.artifactId, { limit: 10 }));
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

  it("rejects malformed, empty, too-large, and ambiguous text sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "videobook-text-errors-"));
    roots.push(root);
    const engine = createEngine({
      dataDir: path.join(root, "data"),
      workspaceDir: path.join(root, "workspace"),
      initialBookName: "text-errors",
      similarity: { provider, text: { provider: textProvider, maxSourceBytes: 8 } },
    });
    try {
      const invalid = value(
        await engine.artifacts.create({ kind: "prompt", label: "prompt-invalid-json" }),
      );
      value(await engine.files.write(invalid.artifactId, "original.json", "{oops"));
      expect(await engine.similarity.index(invalid.artifactId)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });

      const empty = value(
        await engine.artifacts.create({ kind: "character", label: "char-empty-text" }),
      );
      value(await engine.files.write(empty.artifactId, "original.md", "\n\n  \n"));
      expect(await engine.similarity.index(empty.artifactId)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });

      const tooLarge = value(
        await engine.artifacts.create({ kind: "script", label: "script-too-large" }),
      );
      value(await engine.files.write(tooLarge.artifactId, "original.md", "123456789"));
      expect(await engine.similarity.index(tooLarge.artifactId)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });

      const ambiguous = value(
        await engine.artifacts.create({ kind: "scene", label: "scene-ambiguous" }),
      );
      value(await engine.files.write(ambiguous.artifactId, "original.md", "cat"));
      value(await engine.files.write(ambiguous.artifactId, "original.txt", "cat"));
      expect(await engine.similarity.index(ambiguous.artifactId)).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
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

function textVector(content: string): Float32Array {
  const lower = content.toLocaleLowerCase();
  const cat = lower.includes("cat") || lower.includes("feline");
  const rug = lower.includes("rug") || lower.includes("mat");
  const ocean = lower.includes("ocean") || lower.includes("boat");
  const calm = lower.includes("calm") || lower.includes("quiet");
  const vector = new Float32Array([cat ? 1 : 0, rug ? 1 : 0, ocean ? 1 : 0, calm ? 1 : 0]);
  if (vector.every((item) => item === 0)) vector[3] = 1;
  return vector;
}

function audioVector(content: string): Float32Array {
  if (content.startsWith("purr variant")) {
    return new Float32Array([0.98, 0.2, 0]);
  }
  if (content.startsWith("purr")) return new Float32Array([1, 0, 0]);
  return new Float32Array([0, 1, 0]);
}

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function removeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 1 });
}
