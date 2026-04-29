import { describe, it, expect } from "vitest";
import type { AssetManifestFile } from "../src/index.js";
import { findAudioFile, findVideoFile } from "../src/asset/media-files.js";

function makeFile(name: string, ext: string | null = null): AssetManifestFile {
  return { name, size_bytes: 1024, extension: ext, mtimeMs: 0 };
}

describe("findAudioFile", () => {
  describe("vid- prefix assets", () => {
    it("finds audio_original.mp3", () => {
      const files = [
        makeFile("original.mp4", ".mp4"),
        makeFile("audio_original.mp3", ".mp3"),
      ];
      const result = findAudioFile(files, "vid-abc123");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("audio_original.mp3");
    });

    it("falls back to original.mp3 when no audio_original.mp3", () => {
      const files = [
        makeFile("original.mp4", ".mp4"),
        makeFile("original.mp3", ".mp3"),
      ];
      const result = findAudioFile(files, "vid-abc123");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("original.mp3");
    });

    it("returns null when no matching audio file exists", () => {
      const files = [makeFile("original.mp4", ".mp4")];
      const result = findAudioFile(files, "vid-abc123");
      expect(result).toBeNull();
    });
  });

  describe("aud- prefix assets", () => {
    it("finds files with audio extensions", () => {
      const files = [makeFile("track.wav", ".wav")];
      const result = findAudioFile(files, "aud-track1");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("track.wav");
    });

    it("finds mp3 files", () => {
      const files = [makeFile("podcast.mp3", ".mp3")];
      const result = findAudioFile(files, "aud-podcast");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("podcast.mp3");
    });

    it("finds m4a files", () => {
      const files = [makeFile("voice.m4a", ".m4a")];
      const result = findAudioFile(files, "aud-voice");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("voice.m4a");
    });

    it("returns null when no audio extension files exist", () => {
      const files = [makeFile("readme.txt", ".txt")];
      const result = findAudioFile(files, "aud-something");
      expect(result).toBeNull();
    });
  });

  describe("other prefix assets", () => {
    it("returns null for img- prefix", () => {
      const files = [makeFile("original.png", ".png")];
      const result = findAudioFile(files, "img-photo");
      expect(result).toBeNull();
    });

    it("returns null for script- prefix", () => {
      const files = [makeFile("original.md", ".md")];
      const result = findAudioFile(files, "script-notes");
      expect(result).toBeNull();
    });
  });
});

describe("findVideoFile", () => {
  it("prefers original.mp4 over other video files", () => {
    const files = [
      makeFile("clip.mp4", ".mp4"),
      makeFile("original.mp4", ".mp4"),
    ];
    const result = findVideoFile(files);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("original.mp4");
  });

  it("prefers any file starting with 'original' over others", () => {
    const files = [
      makeFile("clip.mov", ".mov"),
      makeFile("original.mov", ".mov"),
    ];
    const result = findVideoFile(files);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("original.mov");
  });

  it("falls back to first video file when no original exists", () => {
    const files = [
      makeFile("clip.mp4", ".mp4"),
      makeFile("preview.mov", ".mov"),
    ];
    const result = findVideoFile(files);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("clip.mp4");
  });

  it("returns null when no video files exist", () => {
    const files = [
      makeFile("photo.png", ".png"),
      makeFile("audio.mp3", ".mp3"),
    ];
    const result = findVideoFile(files);
    expect(result).toBeNull();
  });

  it("returns null for empty file list", () => {
    const result = findVideoFile([]);
    expect(result).toBeNull();
  });

  it("handles files using name-based extension when extension field is null", () => {
    const files = [makeFile("clip.webm", null)];
    const result = findVideoFile(files);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("clip.webm");
  });

  it("handles files using name-based extension for non-video files", () => {
    const files = [makeFile("readme.txt", null)];
    const result = findVideoFile(files);
    expect(result).toBeNull();
  });
});
