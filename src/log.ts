import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "./types.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function validateName(name: string): Result<string, FsError> {
  if (!NAME_PATTERN.test(name)) {
    return err({
      code: "INVALID_INPUT",
      message: `Invalid log name "${name}": must match /^[a-z0-9][a-z0-9-]*$/`,
    });
  }
  return ok(name);
}

export async function appendLog(
  projectDir: string,
  name: string,
  line: Record<string, unknown>,
): Promise<Result<string, FsError>> {
  const valid = validateName(name);
  if (!valid.ok) return valid;

  const logsDir = path.join(projectDir, "logs");
  const filePath = path.join(logsDir, `${name}.jsonl`);

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(line) + "\n");
    return ok(filePath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err({ code: "IO_ERROR", message: msg });
  }
}

export async function readLog(
  projectDir: string,
  name: string,
  options?: { limit?: number },
): Promise<Record<string, unknown>[]> {
  const valid = validateName(name);
  if (!valid.ok) return [];

  const filePath = path.join(projectDir, "logs", `${name}.jsonl`);
  const limit = options?.limit ?? 20;

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n").filter((l) => l.trim());
  const tail = lines.slice(-limit);

  const results: Record<string, unknown>[] = [];
  for (const raw of tail) {
    try {
      results.push(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      // skip unparseable lines
    }
  }
  return results;
}
