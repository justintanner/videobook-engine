import { spawn } from "node:child_process";
import type { MediaOperationOptions } from "./engine-types.js";
import { EngineFault } from "./store.js";

const DEFAULT_MEDIA_TIMEOUT_MS = 120_000;
const DEFAULT_STDOUT_LIMIT = 8 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT = 64 * 1024;

interface MediaProcessOptions extends MediaOperationOptions {
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export function mediaTimeout(options: MediaOperationOptions): number {
  const timeout = options.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
    throw new EngineFault({ code: "INVALID_INPUT", message: "Media timeout must be a positive bounded integer" });
  }
  return timeout;
}

export function checkMediaCancellation(options: MediaOperationOptions): void {
  if (options.signal?.aborted) throw new EngineFault({ code: "CANCELLED", message: "Media operation cancelled" });
}

export async function runMediaProcess(
  command: string,
  args: string[],
  options: MediaProcessOptions = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  checkMediaCancellation(options);
  const timeoutMs = mediaTimeout(options);
  const stdoutLimit = checkedLimit(options.maxStdoutBytes ?? DEFAULT_STDOUT_LIMIT);
  const stderrLimit = checkedLimit(options.maxStderrBytes ?? DEFAULT_STDERR_LIMIT);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: EngineFault | undefined;
    const stop = (error: EngineFault) => {
      failure ??= error;
      stdout.length = 0;
      stderr.length = 0;
      child.kill("SIGKILL");
    };
    const cancel = () => stop(new EngineFault({ code: "CANCELLED", message: "Media operation cancelled" }));
    const timer = setTimeout(() => stop(new EngineFault({
      code: "TIMEOUT", message: "Media process exceeded its time limit", details: { timeoutMs },
    })), timeoutMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimit) stop(outputLimit("stdout", stdoutLimit));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure) return;
      stderrBytes += chunk.length;
      if (stderrBytes > stderrLimit) stop(outputLimit("stderr", stderrLimit));
      else stderr.push(chunk);
    });
    child.once("error", () => {
      failure ??= new EngineFault({ code: "FEATURE_UNAVAILABLE", message: "Unable to start media process" });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (failure) { reject(failure); return; }
      if (code !== 0) {
        reject(new EngineFault({ code: "INVALID_INPUT", message: "Media process failed", details: { exitCode: code, signal } }));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new EngineFault({ code: "INVALID_INPUT", message: "Media output limit must be a non-negative integer" });
  }
  return limit;
}

function outputLimit(stream: string, limitBytes: number): EngineFault {
  return new EngineFault({
    code: "RESOURCE_EXHAUSTED", message: "Media process exceeded its output limit", details: { stream, limitBytes },
  });
}
