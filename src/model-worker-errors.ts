import { ENGINE_ERROR_CODES, type EngineError } from "./engine-types.js";
import { EngineFault } from "./store.js";

export function modelWorkerError(error: unknown): EngineError {
  if (error instanceof Error && /out of memory|allocation failed|bad_alloc|memory limit|failed to allocate memory/iu.test(error.message)) {
    return { code: "RESOURCE_EXHAUSTED", message: "Model worker exhausted its available memory" };
  }
  if (error instanceof EngineFault && ENGINE_ERROR_CODES.includes(error.error.code)) {
    return { code: error.error.code, message: error.error.message.slice(0, 2048) };
  }
  return { code: "MODEL_UNAVAILABLE", message: "Local model operation failed" };
}
