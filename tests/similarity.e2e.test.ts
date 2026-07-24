import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/engine.js";

const run = promisify(execFile);
const imageSource = process.env.VIDEOBOOK_E2E_IMAGE ??
  "/Users/jwt/.codex/attachments/68ea19ef-e59e-4c0b-8d02-47fdcbc1f9e9/image-1.jpg";
const imageDuplicate = path.resolve("vancat_profile.jpg");
const videoSource = process.env.VIDEOBOOK_E2E_VIDEO ??
  path.resolve("vancat.mp4");
const runRealMedia = process.env.VIDEOBOOK_REAL_MEDIA_E2E === "1";
const realDescribe = runRealMedia ? describe : describe.skip;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

realDescribe("local similarity real-media E2E", () => {
  it(
    "indexes and finds the supplied JPEG and vancat video through transformed local variants",
    async () => {
      expect(existsSync(imageSource), `Missing E2E image: ${imageSource}`).toBe(true);
      expect(existsSync(imageDuplicate), `Missing local duplicate: ${imageDuplicate}`).toBe(true);
      expect(existsSync(videoSource), `Missing E2E video: ${videoSource}`).toBe(true);

      const root = await mkdtemp(path.join(tmpdir(), "videobook-sim-e2e-"));
      roots.push(root);
      const imageVariant = path.join(root, "vancat-reencoded.jpg");
      const videoVariant = path.join(root, "vancat-reencoded.mp4");
      await sharp(imageSource)
        .resize(768, 768, { fit: "inside" })
        .jpeg({ quality: 76 })
        .toFile(imageVariant);
      await run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        videoSource,
        "-vf",
        "scale=576:576",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "30",
        "-an",
        videoVariant,
      ]);

      let engine: Engine | null = createEngine({
        dataDir: path.join(root, "data"),
        workspaceDir: path.join(root, "workspaces"),
        similarity: {
          modelCacheDir: process.env.VIDEOBOOK_E2E_MODEL_CACHE ??
            path.join(tmpdir(), "videobook-model-cache"),
        },
      });
      try {
        const project = value(await engine.projects.create("real-media"));
        const image = value(await engine.artifacts.create({
          project: project.projectId,
          kind: "image",
          slug: "img-vancat-source",
        }));
        const imageExact = value(await engine.artifacts.create({
          project: project.projectId,
          kind: "image",
          slug: "img-vancat-exact",
        }));
        const imageTranscoded = value(await engine.artifacts.create({
          project: project.projectId,
          kind: "image",
          slug: "img-vancat-transcoded",
        }));
        const video = value(await engine.artifacts.create({
          project: project.projectId,
          kind: "video",
          slug: "vid-vancat-source",
        }));
        const videoExact = value(await engine.artifacts.create({
          project: project.projectId,
          kind: "video",
          slug: "vid-vancat-exact",
        }));
        const videoTranscoded = value(await engine.artifacts.create({
          project: project.projectId,
          kind: "video",
          slug: "vid-vancat-transcoded",
        }));

        value(await engine.files.writeFromPath(
          image.artifactId,
          "original.jpg",
          imageSource,
          project.projectId,
        ));
        value(await engine.files.writeFromPath(
          imageExact.artifactId,
          "original.jpg",
          imageDuplicate,
          project.projectId,
        ));
        value(await engine.files.writeFromPath(
          imageTranscoded.artifactId,
          "original.jpg",
          imageVariant,
          project.projectId,
        ));
        value(await engine.files.writeFromPath(
          video.artifactId,
          "original.mp4",
          videoSource,
          project.projectId,
        ));
        value(await engine.files.writeFromPath(
          videoExact.artifactId,
          "original.mp4",
          videoSource,
          project.projectId,
        ));
        value(await engine.files.writeFromPath(
          videoTranscoded.artifactId,
          "original.mp4",
          videoVariant,
          project.projectId,
        ));

        value(await engine.similarity.prepare());
        for (const artifact of [
          image,
          imageExact,
          imageTranscoded,
          video,
          videoExact,
          videoTranscoded,
        ]) {
          value(await engine.similarity.index(project.projectId, artifact.artifactId));
        }

        const imageMatches = value(await engine.similarity.findSimilar(
          project.projectId,
          image.artifactId,
          { limit: 10 },
        ));
        expect(imageMatches[0]).toMatchObject({
          artifactId: imageExact.artifactId,
          exactBytes: true,
          kind: "image",
          score: 1,
        });
        const imageSemantic = imageMatches.find(
          (match) => match.artifactId === imageTranscoded.artifactId,
        );
        expect(imageSemantic).toBeDefined();
        expect(imageSemantic?.exactBytes).toBe(false);
        expect(imageSemantic?.score).toBeGreaterThan(0.7);

        const videoMatches = value(await engine.similarity.findSimilar(
          project.projectId,
          video.artifactId,
          { limit: 10 },
        ));
        expect(videoMatches[0]).toMatchObject({
          artifactId: videoExact.artifactId,
          exactBytes: true,
          kind: "video",
          score: 1,
        });
        const videoSemantic = videoMatches.find(
          (match) => match.artifactId === videoTranscoded.artifactId,
        );
        expect(videoSemantic).toBeDefined();
        expect(videoSemantic?.exactBytes).toBe(false);
        expect(videoSemantic?.score).toBeGreaterThan(0.7);

        expect(value(engine.similarity.stats(project.projectId))).toMatchObject({
          imageCount: 3,
          videoCount: 3,
        });

        engine.close();
        engine = createEngine({
          dataDir: path.join(root, "data"),
          workspaceDir: path.join(root, "workspaces"),
          similarity: {
            modelCacheDir: process.env.VIDEOBOOK_E2E_MODEL_CACHE ??
              path.join(tmpdir(), "videobook-model-cache"),
          },
        });
        const reopened = value(await engine.similarity.findSimilar(
          project.projectId,
          video.artifactId,
          { limit: 10 },
        ));
        expect(reopened[0]?.artifactId).toBe(videoExact.artifactId);
      } finally {
        engine?.close();
      }
    },
    180_000,
  );
});

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
