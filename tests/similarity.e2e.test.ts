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
const videoSource = process.env.VIDEOBOOK_E2E_VIDEO ?? path.resolve("vancat.mp4");
const realDescribe = process.env.VIDEOBOOK_REAL_MEDIA_E2E === "1" ? describe : describe.skip;
const realAudioDescribe = process.env.VIDEOBOOK_REAL_AUDIO_E2E === "1"
  ? describe
  : describe.skip;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

realDescribe("single-book local similarity real-media E2E", () => {
  it(
    "indexes image and video variants in the engine's one book-wide pool",
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
        initialBookName: "real-media",
        similarity: {
          modelCacheDir: process.env.VIDEOBOOK_E2E_MODEL_CACHE ??
            path.join(tmpdir(), "videobook-model-cache"),
        },
      });
      try {
        const image = value(await engine.artifacts.create({ kind: "image", label: "img-source" }));
        const imageExact = value(await engine.artifacts.create({ kind: "image", label: "img-exact" }));
        const imageTranscoded = value(
          await engine.artifacts.create({ kind: "image", label: "img-transcoded" }),
        );
        const video = value(await engine.artifacts.create({ kind: "video", label: "vid-source" }));
        const videoExact = value(await engine.artifacts.create({ kind: "video", label: "vid-exact" }));
        const videoTranscoded = value(
          await engine.artifacts.create({ kind: "video", label: "vid-transcoded" }),
        );
        for (const [artifact, name, source] of [
          [image, "original.jpg", imageSource],
          [imageExact, "original.jpg", imageDuplicate],
          [imageTranscoded, "original.jpg", imageVariant],
          [video, "original.mp4", videoSource],
          [videoExact, "original.mp4", videoSource],
          [videoTranscoded, "original.mp4", videoVariant],
        ] as const) {
          value(await engine.files.writeFromPath(artifact.artifactId, name, source));
        }
        value(await engine.similarity.prepare());
        for (const artifact of [
          image,
          imageExact,
          imageTranscoded,
          video,
          videoExact,
          videoTranscoded,
        ]) {
          value(await engine.similarity.index(artifact.artifactId));
        }
        const imageMatches = value(await engine.similarity.findSimilar(image.artifactId, { limit: 10 }));
        expect(imageMatches[0]).toMatchObject({ artifactId: imageExact.artifactId, exactBytes: true });
        expect(imageMatches.find((match) => match.artifactId === imageTranscoded.artifactId)?.score)
          .toBeGreaterThan(0.7);
        const videoMatches = value(await engine.similarity.findSimilar(video.artifactId, { limit: 10 }));
        expect(videoMatches[0]).toMatchObject({ artifactId: videoExact.artifactId, exactBytes: true });
        expect(videoMatches.find((match) => match.artifactId === videoTranscoded.artifactId)?.score)
          .toBeGreaterThan(0.7);
        expect(value(engine.similarity.stats())).toMatchObject({ imageCount: 3, videoCount: 3 });
      } finally {
        engine?.close();
      }
    },
    180_000,
  );
});

realAudioDescribe("single-book local audio similarity real-media E2E", () => {
  it(
    "indexes exact and transcoded audio with the local CLAP provider",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "videobook-audio-e2e-"));
      roots.push(root);
      const source = path.join(root, "tone.wav");
      const transcoded = path.join(root, "tone.mp3");
      await run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:a",
        "pcm_s16le",
        source,
      ]);
      await run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        source,
        "-b:a",
        "64k",
        transcoded,
      ]);

      const engine = createEngine({
        dataDir: path.join(root, "data"),
        workspaceDir: path.join(root, "workspaces"),
        initialBookName: "real-audio",
        similarity: {
          audio: {
            modelCacheDir: process.env.VIDEOBOOK_E2E_AUDIO_MODEL_CACHE ??
              path.join(tmpdir(), "videobook-audio-model-cache"),
          },
        },
      });
      try {
        const original = value(
          await engine.artifacts.create({ kind: "audio", label: "aud-source" }),
        );
        const exact = value(
          await engine.artifacts.create({ kind: "audio", label: "aud-exact" }),
        );
        const variant = value(
          await engine.artifacts.create({ kind: "audio", label: "aud-transcoded" }),
        );
        value(
          await engine.files.writeFromPath(
            original.artifactId,
            "original.wav",
            source,
          ),
        );
        value(
          await engine.files.writeFromPath(
            exact.artifactId,
            "original.wav",
            source,
          ),
        );
        value(
          await engine.files.writeFromPath(
            variant.artifactId,
            "original.mp3",
            transcoded,
          ),
        );

        value(await engine.similarity.prepare({ kind: "audio" }));
        for (const artifact of [original, exact, variant]) {
          value(await engine.similarity.index(artifact.artifactId));
        }
        const matches = value(
          await engine.similarity.findSimilar(original.artifactId, { limit: 10 }),
        );
        expect(matches[0]).toMatchObject({
          artifactId: exact.artifactId,
          kind: "audio",
          exactBytes: true,
        });
        expect(
          matches.find((match) => match.artifactId === variant.artifactId)?.score,
        ).toBeGreaterThan(0.8);
      } finally {
        engine.close();
      }
    },
    180_000,
  );
});

function value<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
