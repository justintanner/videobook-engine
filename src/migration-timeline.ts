import { execFile } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "@dolthub/doltlite";
import sharp from "sharp";
import { v7 as uuidv7 } from "uuid";

import type { ObjectStore } from "./cas.js";
import type { Engine } from "./engine.js";
import type { ArtifactStream, ClipPlacement, EditOperation, MigrationIssue, V4MigrationRequest } from "./mvp-contracts.js";
import { MVP_CONTRACT_VERSION } from "./mvp-contracts.js";
import { sequenceFramesToSourceTicks, sourceTicksToSequenceFrames } from "./mvp-time.js";
import { EngineFault } from "./store.js";

interface LegacyPlacement {
  legacyId: string;
  artifactId: string;
  path: string;
  objectHash: string;
  kind: "image" | "video" | "audio";
  startFrame?: number;
  durationFrames?: number;
  volume: number | null;
  fadeInMs: number | null;
  fadeOutMs: number | null;
}

interface LegacyFile { artifact_id: string; path: string; object_hash: string }
interface LegacySlot {
  slot_id: string; artifact_id: string; kind: string; volume: number | null;
  audio_fade_in: number | null; audio_fade_out: number | null;
}
interface LegacyAudio {
  audio_id: string; artifact_id: string; kind: string; start_frame: number; duration_frames: number;
  volume: number | null; fade_in: number | null; fade_out: number | null;
}

export function legacyTimelinePlan(database: DatabaseSync): { placements: LegacyPlacement[]; issues: MigrationIssue[] } {
  const files = database.prepare("SELECT artifact_id, path, object_hash FROM artifact_files ORDER BY artifact_id, path").all() as unknown as LegacyFile[];
  const slots = database.prepare(`SELECT s.*, a.kind FROM timeline_slots s JOIN artifacts a ON a.artifact_id=s.artifact_id
    ORDER BY s.ordinal, s.slot_id`).all() as unknown as LegacySlot[];
  const audio = database.prepare(`SELECT s.*, a.kind FROM timeline_audio s JOIN artifacts a ON a.artifact_id=s.artifact_id
    ORDER BY s.ordinal, s.audio_id`).all() as unknown as LegacyAudio[];
  const placements: LegacyPlacement[] = [];
  const issues: MigrationIssue[] = [];
  const add = (legacyId: string, artifactId: string, kind: LegacyPlacement["kind"], values: Pick<LegacyPlacement, "volume" | "fadeInMs" | "fadeOutMs" | "startFrame" | "durationFrames">): void => {
    const extensions = kind === "image" ? [".png", ".jpg", ".jpeg", ".webp", ".avif"]
      : kind === "video" ? [".mp4", ".mov", ".webm", ".mkv", ".avi"]
        : [".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".weba", ".mp4", ".mov", ".webm"];
    const candidates = files.filter((file) => file.artifact_id === artifactId && extensions.includes(extname(file.path).toLowerCase()));
    candidates.sort((left, right) => sourcePriority(left.path, kind) - sourcePriority(right.path, kind) || left.path.localeCompare(right.path));
    const file = candidates[0];
    if (!file) {
      issues.push({ code: "UNSUPPORTED_MEDIA", severity: "error", resource: `timeline:${legacyId}`, message: `No supported ${kind} source file`, details: { artifactId } });
      return;
    }
    if ([values.volume, values.fadeInMs, values.fadeOutMs].some((value) => value !== null && (!Number.isFinite(value) || value < 0))
      || (values.startFrame !== undefined && (!Number.isSafeInteger(values.startFrame) || values.startFrame < 0))
      || (values.durationFrames !== undefined && (!Number.isSafeInteger(values.durationFrames) || values.durationFrames <= 0))) {
      issues.push({ code: "INVALID_REFERENCE", severity: "error", resource: `timeline:${legacyId}`, message: "Invalid legacy placement, volume or fade" });
      return;
    }
    placements.push({ legacyId, artifactId, path: file.path, objectHash: file.object_hash, kind, ...values });
    if (kind !== "image") issues.push({ code: "PROBE_REQUIRED", severity: "warning", resource: `timeline:${legacyId}`,
      message: `${kind} source will be probed during migration before publishing clips`, details: { artifactId, sourcePath: file.path } });
  };
  for (const slot of slots) {
    if (!["image", "video", "final"].includes(slot.kind)) {
      issues.push({ code: "UNSUPPORTED_MEDIA", severity: "error", resource: `timeline:${slot.slot_id}`, message: `Unsupported video-track artifact kind: ${slot.kind}` });
      continue;
    }
    add(slot.slot_id, slot.artifact_id, slot.kind === "image" ? "image" : "video", {
      volume: slot.volume, fadeInMs: slot.audio_fade_in, fadeOutMs: slot.audio_fade_out,
    });
  }
  for (const clip of audio) add(clip.audio_id, clip.artifact_id, "audio", {
    startFrame: clip.start_frame, durationFrames: clip.duration_frames,
    volume: clip.volume, fadeInMs: clip.fade_in, fadeOutMs: clip.fade_out,
  });
  return { placements, issues };
}

export async function convertLegacyTimeline(engine: Engine, plan: ReturnType<typeof legacyTimelinePlan>, objects: ObjectStore, request: V4MigrationRequest) {
  const sequence = engine.sequences.getPrimary();
  const videoTrack = sequence.tracks.find((track) => track.kind === "video")!;
  const audioTrack = sequence.tracks.find((track) => track.kind === "audio")!;
  const streams = new Map<string, ArtifactStream>();
  const images = new Set<string>();
  const decisions: Array<{ legacyId: string; clipId: string; sourcePath: string; objectHash: string; startFrame: number; durationFrames: number }> = [];
  let videoEndFrame = 0;
  let audioEndFrame = 0;
  let operations: EditOperation[] = [];
  const flush = async (): Promise<void> => {
    if (!operations.length) return;
    const intent = { intentVersion: MVP_CONTRACT_VERSION, commandId: uuidv7(), sequenceId: sequence.sequenceId,
      baseRevision: engine.head, actor: "schema-v4-migration", sourceSurface: "system" as const,
      confirmationPolicy: "always" as const, operations };
    const preview = engine.edits.preview(intent);
    if (!preview.ok) throw new EngineFault(preview.error);
    if (!preview.value.valid) throw new EngineFault({ code: "INVALID_INPUT", message: "Legacy timeline cannot be represented",
      details: { conflicts: preview.value.conflicts } });
    const committed = await engine.edits.commit(intent, preview.value.previewHash);
    if (!committed.ok) throw new EngineFault(committed.error);
    operations = [];
  };
  for (const [index, item] of plan.placements.entries()) {
    if (request.signal?.aborted) throw new EngineFault({ code: "CANCELLED", message: "Schema-v4 migration cancelled" });
    const filePath = await objects.ensureLocalPath(item.objectHash);
    let source: ClipPlacement["source"];
    let durationFrames: number;
    if (item.kind === "image") {
      if (!images.has(item.objectHash)) {
        const metadata = await sharp(filePath).metadata();
        if (!metadata.width || !metadata.height) throw new Error(`Invalid legacy image: ${item.path}`);
        images.add(item.objectHash);
      }
      source = { kind: "still", artifactId: item.artifactId, sourcePath: item.path, objectHash: item.objectHash };
      durationFrames = 90;
    } else {
      const key = `${item.artifactId}:${item.path}:${item.kind}`;
      let stream = streams.get(key);
      if (!stream) {
        const profile = await probeStream(filePath, item.kind, request);
        const registered = await engine.streams.register({ ...profile, artifactId: item.artifactId, sourcePath: item.path, objectHash: item.objectHash });
        if (!registered.ok) throw new EngineFault(registered.error);
        stream = registered.value;
        streams.set(key, stream);
      }
      durationFrames = item.durationFrames ?? Math.max(1, sourceTicksToSequenceFrames(stream.durationTicks, stream.timeBase, sequence.frameRate));
      const durationTicks = item.kind === "audio"
        ? Math.max(1, Math.min(stream.durationTicks, sequenceFramesToSourceTicks(durationFrames, sequence.frameRate, stream.timeBase)))
        : stream.durationTicks;
      source = { kind: "timed", artifactId: item.artifactId, range: { streamId: stream.streamId, objectHash: item.objectHash,
        startTick: 0, durationTicks, timeBase: stream.timeBase } };
    }
    const timelineStartFrame = item.startFrame ?? videoEndFrame;
    const fadeInFrames = Math.round((item.fadeInMs ?? 0) * 30 / 1000);
    const fadeOutFrames = Math.round((item.fadeOutMs ?? 0) * 30 / 1000);
    if (fadeInFrames + fadeOutFrames > durationFrames) {
      throw new EngineFault({ code: "INVALID_INPUT", message: `Legacy fades exceed the clip duration: ${item.legacyId}`,
        details: { legacyId: item.legacyId, durationFrames, fadeInFrames, fadeOutFrames } });
    }
    const clipId = uuidv7();
    const placement: ClipPlacement = {
      trackId: item.kind === "audio" ? audioTrack.trackId : videoTrack.trackId, timelineStartFrame, durationFrames, source,
      ...(source.kind === "timed" ? { speed: { numerator: 1, denominator: 1 }, reverse: false, audioPolicy: "preserve-pitch" as const } : {}),
      ...(item.kind !== "audio" ? { transform: { fit: "fit" as const, positionX: 0, positionY: 0, scaleX: 1, scaleY: 1,
        anchorX: 0.5, anchorY: 0.5, rotationDegrees: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0, opacity: 1, blendMode: "normal" as const } } : {}),
      audio: { gainDb: item.volume === null ? 0 : item.volume === 0 ? -120 : 20 * Math.log10(item.volume / 100),
        muted: item.volume === 0, fadeInFrames, fadeOutFrames },
    };
    if (item.kind === "audio") {
      operations.push({ kind: "insert-clip", clipId, placement: { ...placement, timelineStartFrame: audioEndFrame }, mode: "insert" });
      operations.push({ kind: "move-clip", clipId, trackId: audioTrack.trackId, timelineStartFrame });
      audioEndFrame = Math.max(audioEndFrame, timelineStartFrame + durationFrames);
    } else operations.push({ kind: "insert-clip", clipId, placement, mode: "overwrite" });
    decisions.push({ legacyId: item.legacyId, clipId, sourcePath: item.path, objectHash: item.objectHash, startFrame: timelineStartFrame, durationFrames });
    if (item.kind !== "audio") videoEndFrame += durationFrames;
    if (operations.length >= 100) await flush();
    request.onProgress?.({ phase: "copy-timeline", completed: index + 1, total: plan.placements.length });
  }
  if (request.signal?.aborted) throw new EngineFault({ code: "CANCELLED", message: "Schema-v4 migration cancelled" });
  await flush();
  return { clips: decisions, videoDurationFrames: videoEndFrame, streams: [...streams.values()], frameRate: sequence.frameRate,
    audioPlacement: "legacy start/duration at 30fps; native playback speed; fades in milliseconds" };
}

function sourcePriority(path: string, kind: string): number {
  if (kind === "audio" && /^audio_original\./i.test(path)) return 0;
  if (/^original\./i.test(path)) return 1;
  return 2;
}

async function probeStream(filePath: string, kind: "audio" | "video", request: V4MigrationRequest): Promise<Omit<ArtifactStream, "streamId" | "artifactId" | "sourcePath" | "objectHash">> {
  const { stdout } = await promisify(execFile)(request.ffprobePath ?? "ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
    { encoding: "utf8", signal: request.signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const data = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>>; format?: { duration?: string } };
  const stream = data.streams?.find((value) => value.codec_type === kind);
  if (!stream) throw new EngineFault({ code: "INVALID_INPUT", message: `No ${kind} stream in legacy media` });
  const timeBase = ratio(String(stream.time_base));
  const durationTicks = Number(stream.duration_ts ?? Math.round(Number(stream.duration ?? data.format?.duration) * timeBase.denominator / timeBase.numerator));
  if (!Number.isSafeInteger(durationTicks) || durationTicks <= 0) throw new EngineFault({ code: "INVALID_INPUT", message: "Legacy media has no finite positive source duration" });
  const common = { streamIndex: Number(stream.index), kind, timeBase, durationTicks, codec: String(stream.codec_name ?? "unknown") };
  if (kind === "audio") return { ...common, audio: { sampleRateHz: Number(stream.sample_rate), channels: Number(stream.channels),
    channelLayout: String(stream.channel_layout ?? (Number(stream.channels) === 1 ? "mono" : Number(stream.channels) === 2 ? "stereo" : "unknown")) } };
  const sideData = stream.side_data_list as Array<{ rotation?: number }> | undefined;
  const tags = stream.tags as { rotate?: string } | undefined;
  const rotationDegrees = Number(sideData?.find((value) => value.rotation !== undefined)?.rotation ?? tags?.rotate ?? 0);
  return { ...common, video: { width: Number(stream.width), height: Number(stream.height), rotationDegrees,
    pixelAspect: !stream.sample_aspect_ratio || stream.sample_aspect_ratio === "N/A" || stream.sample_aspect_ratio === "0:1"
      ? { numerator: 1, denominator: 1 } : ratio(String(stream.sample_aspect_ratio).replace(":", "/")),
    ...(stream.avg_frame_rate && stream.avg_frame_rate !== "0/0" ? { averageFrameRate: ratio(String(stream.avg_frame_rate)) } : {}) } };
}

function ratio(value: string): { numerator: number; denominator: number } {
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator! <= 0 || denominator! <= 0) throw new Error(`Invalid legacy media ratio: ${value}`);
  return { numerator: numerator!, denominator: denominator! };
}
