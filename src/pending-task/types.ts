/**
 * The set of external/long-running task types whose lifecycle is tracked in
 * the `pending_tasks` table. Each value identifies a provider+modality pair
 * (e.g. fal_seedance2_t2v = FAL Seedance v2 text-to-video). Adding a new
 * generation provider or modality means adding a literal here.
 */
export type TaskType =
  | "nano_banana_image"
  | "qwen2_image_edit"
  | "seedream_text_image"
  | "seedream_image"
  | "grok_imagine_video"
  | "grok_imagine_image"
  | "grok_imagine_text"
  | "gpt_image"
  | "gpt_image_text"
  | "kling30_video"
  | "kling30_motion_control_video"
  | "seedance2_video"
  | "wan27_image"
  | "wan27_image_pro"
  | "wan27_t2v_video"
  | "wan27_i2v_video"
  | "wan27_videoedit_video"
  | "wan27_r2v_video"
  | "wan27_extend_video"
  | "happyhorse_t2v_video"
  | "happyhorse_i2v_video"
  | "happyhorse_ref_video"
  | "happyhorse_videoedit_video"
  | "grok_imagine_t2v_video"
  | "transcribe"
  | "fal_transcribe"
  | "isolate_vocals"
  | "xai_grok_imagine_video"
  | "xai_grok_imagine_ref_video"
  | "grok_imagine_extend_video"
  | "grok_imagine_upscale_video"
  | "alibaba_image"
  | "alibaba_image_pro"
  | "alibaba_video"
  | "alibaba_qwen_image"
  | "alibaba_qwen_image_edit"
  | "fal_seedance2_i2v"
  | "fal_seedance2_t2v"
  | "fal_seedance2_r2v"
  | "fal_seedance2_fast_t2v"
  | "fal_seedance2_fast_i2v"
  | "fal_seedance2_fast_r2v"
  | "fal_nano_banana_pro"
  | "fal_nano_banana_pro_edit"
  | "fal_nano_banana"
  | "fal_nano_banana_edit"
  | "fal_nano_banana_2"
  | "fal_nano_banana_2_edit"
  | "fal_qwen_image"
  | "fal_qwen_image_edit"
  | "fal_seedream_v5_lite"
  | "fal_seedream_v5_lite_edit"
  | "fal_wan27"
  | "fal_wan27_edit"
  | "fal_wan27_pro"
  | "fal_wan27_pro_edit"
  | "fal_wan27_t2v"
  | "fal_wan27_i2v"
  | "fal_wan27_r2v"
  | "fal_wan27_videoedit"
  | "fal_grok_imagine_image"
  | "fal_grok_imagine_image_edit"
  | "fal_kling_v3_pro_i2v"
  | "fal_kling_v3_pro_t2v"
  | "fal_kling_v3_standard_t2v"
  | "fal_kling_v3_standard_i2v"
  | "fal_grok_imagine_video_i2v"
  | "fal_grok_imagine_video_r2v"
  | "fal_grok_imagine_video_extend"
  | "fal_grok_imagine_video_edit"
  | "describe_image"
  | "rewrite_script";

/** Sentinel taskId written by tool handlers before the real provider task is created. */
export const QUEUED_TASK_ID = "queued";

export interface PendingTask {
  assetId: string;
  taskId: string;
  taskType: TaskType;
  assetDir: string;
  /** Epoch seconds (fractional precision). */
  createdAt: number;
  meta: Record<string, unknown>;
  /** Set true when sync has enqueued a complete-task job; dedup guard. */
  completing: boolean;
  /** Provider lease token. Mirrored on assets.owner_id; sync renews per-row. */
  ownerId: string | null;
}

export interface FailureInfo {
  message: string;
  failCode?: string;
  prompt?: string | null;
}

export interface GenerationError {
  assetId: string;
  message: string;
  failCode?: string;
  prompt?: string | null;
  /** Epoch seconds (fractional precision). */
  failedAt: number;
}

export interface PendingTaskRow {
  asset_id: string;
  task_id: string;
  task_type: string;
  asset_dir: string;
  created_at: number;
  meta: string;
  completing: number;
  owner_id: string | null;
}

export interface GenerationErrorRow {
  asset_id: string;
  message: string;
  fail_code: string | null;
  prompt: string | null;
  failed_at: number;
}

export function rowToPendingTask(row: PendingTaskRow): PendingTask {
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.meta) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    // Tolerate corrupt JSON; keep meta empty.
  }
  return {
    assetId: row.asset_id,
    taskId: row.task_id,
    taskType: row.task_type as TaskType,
    assetDir: row.asset_dir,
    createdAt: row.created_at,
    meta,
    completing: row.completing === 1,
    ownerId: row.owner_id,
  };
}

export function rowToGenerationError(row: GenerationErrorRow): GenerationError {
  return {
    assetId: row.asset_id,
    message: row.message,
    ...(row.fail_code !== null ? { failCode: row.fail_code } : {}),
    ...(row.prompt !== null ? { prompt: row.prompt } : {}),
    failedAt: row.failed_at,
  };
}
