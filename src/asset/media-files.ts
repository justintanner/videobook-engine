import type { AssetManifestFile } from "../types.js";
import { extname } from "node:path";

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "avi", "mkv"]);

export const RENDER_ORIENTATIONS = ["landscape", "portrait", "square"] as const;
export type RenderOrientation = (typeof RENDER_ORIENTATIONS)[number];

export function findAudioFile(files: AssetManifestFile[], assetId: string): AssetManifestFile | null {
  if (assetId.startsWith("vid-")) {
    return files.find((f) => f.name === "audio_original.mp3")
      ?? files.find((f) => f.name === "original.mp3")
      ?? null;
  }
  if (assetId.startsWith("aud-")) {
    return files.find((f) => {
      const ext = (f.extension ?? "").replace(/^\./, "").toLowerCase();
      return AUDIO_EXTENSIONS.has(ext);
    }) ?? null;
  }
  return null;
}

/**
 * Lenient: returns the first video file in the asset, preferring any file
 * starting with `original`. Used by video-editing tools (trim, reverse,
 * extract-audio, change-speed, extract-frame) which operate on whatever
 * video is present in the asset directory, including non-original outputs.
 */
export function findVideoFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const videos = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  });
  return videos.find((f) => f.name.startsWith("original")) ?? videos[0] ?? null;
}

/**
 * Strict: the canonical "primary media" for an asset. Only `original.*` is
 * considered, except for the `final` singleton, which is the rendered
 * timeline (`timeline_<orientation>.mp4`). Used by sync, export-to-downloads,
 * and copy-file-to-clipboard where we want THE asset, not just any file
 * lying in its directory.
 */
export function findPrimaryMediaFile(
  files: AssetManifestFile[],
  assetId: string,
): AssetManifestFile | null {
  if (assetId === "final") {
    for (const orient of RENDER_ORIENTATIONS) {
      const match = files.find(
        (f) => f.name.toLowerCase() === `timeline_${orient}.mp4`,
      );
      if (match) return match;
    }
    return null;
  }
  return (
    files.find((f) => /^original\.(mp4|mov)$/i.test(f.name))
    ?? files.find((f) => /^original\.(png|jpe?g|webp)$/i.test(f.name))
    ?? files.find((f) => /^original\.(mp3|wav)$/i.test(f.name))
    ?? files.find((f) => /^original\.md$/i.test(f.name))
    ?? null
  );
}
