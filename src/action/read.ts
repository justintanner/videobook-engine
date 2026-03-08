import type { ActionLogEntry } from "../types.js";
import { gitExecSafe } from "../git/exec.js";
import { isGitRepo } from "../git/init.js";

export interface ActionLogOptions {
  limit?: number;
  since?: string;
}

const RECORD_SEP = "\x00";
const FIELD_SEP = "\x1f";

// Use git's own %xNN specifiers to avoid embedding raw control bytes in argv
const GIT_FORMAT = "%H%x1f%s%x1f%b%x1f%aI%x00";

function parsePayload(body: string): string | Record<string, unknown> {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return trimmed;
  }
}

function parseAction(subject: string): string {
  const match = subject.match(/^\[action:([^\]]+)\]/);
  return match ? match[1]! : "";
}

export async function readActionLog(
  projectDir: string,
  options?: ActionLogOptions,
  gitPath?: string,
): Promise<ActionLogEntry[]> {
  if (!(await isGitRepo(projectDir))) {
    return [];
  }

  const args = [
    "log",
    `--format=${GIT_FORMAT}`,
    "--grep=^\\[action:",
    "--extended-regexp",
  ];

  if (options?.limit) {
    args.push(`--max-count=${options.limit}`);
  }

  if (options?.since) {
    args.push(`${options.since}..HEAD`);
  }

  const result = await gitExecSafe(args, { cwd: projectDir, gitPath });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return [];
  }

  const records = result.stdout.split(RECORD_SEP).filter((r) => r.trim());
  const entries: ActionLogEntry[] = [];

  for (const record of records) {
    const fields = record.split(FIELD_SEP);
    if (fields.length < 4) continue;

    const hash = fields[0]!.trim();
    const subject = fields[1]!;
    const body = fields[2]!;
    const date = fields[3]!.trim();
    const action = parseAction(subject);

    if (!action) continue;

    entries.push({
      hash,
      action,
      payload: parsePayload(body),
      date,
    });
  }

  return entries;
}
