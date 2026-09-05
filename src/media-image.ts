import { stat } from "node:fs/promises";
import type { MediaOperationOptions } from "./engine-types.js";
import { checkMediaCancellation, mediaTimeout } from "./media-process.js";
import { EngineFault } from "./store.js";

export const MAX_MODEL_IMAGE_PIXELS = 40_000_000;
export const MAX_MODEL_IMAGE_BYTES = 64 * 1024 * 1024;

export async function decodeModelImage(sourcePath: string, options: MediaOperationOptions = {}) {
  checkMediaCancellation(options);
  const timeoutMs = mediaTimeout(options);
  const source = await stat(sourcePath);
  if (!source.isFile()) throw new EngineFault({ code: "INVALID_INPUT", message: "Model image input must be a local regular file" });
  if (source.size > MAX_MODEL_IMAGE_BYTES) {
    throw new EngineFault({ code: "RESOURCE_EXHAUSTED", message: "Model image exceeds the compressed byte limit", details: { limitBytes: MAX_MODEL_IMAGE_BYTES } });
  }
  const { default: sharp } = await import("sharp");
  checkMediaCancellation(options);
  const decoder = sharp(sourcePath, { animated: false, limitInputPixels: MAX_MODEL_IMAGE_PIXELS })
    .timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1000)) })
    .rotate().toColourspace("srgb").removeAlpha().raw();
  try {
    const decoded = await decoder.toBuffer({ resolveWithObject: true });
    checkMediaCancellation(options);
    if (decoded.info.width <= 0 || decoded.info.height <= 0 || decoded.info.channels !== 3) {
      throw new EngineFault({ code: "INVALID_INPUT", message: "Unable to normalize model image to RGB" });
    }
    return decoded;
  } catch (error) {
    if (error instanceof EngineFault) throw error;
    const message = error instanceof Error ? error.message : "";
    throw new EngineFault({
      code: /pixel limit/iu.test(message) ? "RESOURCE_EXHAUSTED" : /timeout/iu.test(message) ? "TIMEOUT" : "INVALID_INPUT",
      message: "Unable to decode model image within the supported limits",
    });
  } finally { decoder.destroy(); }
}
