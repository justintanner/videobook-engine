import { extname } from "node:path";

import type { ArtifactManifestFile } from "./engine-types.js";

const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "ogg",
  "flac",
  "aac",
  "m4a",
  "weba",
]);
const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "webm",
  "avi",
  "mkv",
]);

export const RENDER_ORIENTATIONS = [
  "landscape",
  "portrait",
  "square",
] as const;

export type RenderOrientation = (typeof RENDER_ORIENTATIONS)[number];

export function findAudioFile(
  files: ArtifactManifestFile[],
  artifactSlug: string,
): ArtifactManifestFile | null {
  if (artifactSlug.startsWith("vid-")) {
    return (
      files.find((file) => file.name === "audio_original.mp3") ??
      files.find((file) => file.name === "original.mp3") ??
      null
    );
  }
  if (artifactSlug.startsWith("aud-")) {
    return (
      files.find((file) =>
        AUDIO_EXTENSIONS.has(extension(file)),
      ) ?? null
    );
  }
  return null;
}

export function findVideoFile(
  files: ArtifactManifestFile[],
): ArtifactManifestFile | null {
  const videos = files.filter((file) =>
    VIDEO_EXTENSIONS.has(extension(file)),
  );
  return (
    videos.find((file) => file.name.startsWith("original")) ??
    videos[0] ??
    null
  );
}

export function findPrimaryMediaFile(
  files: ArtifactManifestFile[],
  artifactSlug: string,
): ArtifactManifestFile | null {
  if (artifactSlug === "final") {
    for (const orientation of RENDER_ORIENTATIONS) {
      const match = files.find(
        (file) =>
          file.name.toLowerCase() ===
          `timeline_${orientation}.mp4`,
      );
      if (match) return match;
    }
    return null;
  }
  return (
    files.find((file) => /^original\.(mp4|mov)$/i.test(file.name)) ??
    files.find((file) =>
      /^original\.(png|jpe?g|webp)$/i.test(file.name),
    ) ??
    files.find((file) => /^original\.(mp3|wav)$/i.test(file.name)) ??
    files.find((file) => /^original\.md$/i.test(file.name)) ??
    null
  );
}

function extension(file: ArtifactManifestFile): string {
  return (file.extension ?? extname(file.name))
    .replace(/^\./, "")
    .toLowerCase();
}
