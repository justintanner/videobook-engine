import { gitExecSafe } from "./exec.js";

export interface ProjectTimestamps {
  created: number;
  lastActivity: number;
}

export async function getProjectTimestamps(
  projectDir: string,
  gitPath?: string,
): Promise<ProjectTimestamps | null> {
  const result = await gitExecSafe(["log", "--format=%at", "--reverse"], {
    cwd: projectDir,
    gitPath,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;

  const lines = result.stdout.trim().split("\n");
  const created = parseInt(lines[0]!, 10);
  const lastActivity = parseInt(lines[lines.length - 1]!, 10);
  if (isNaN(created) || isNaN(lastActivity)) return null;

  return { created, lastActivity };
}

export async function getAssetCreationTimestamps(
  projectDir: string,
  gitPath?: string,
): Promise<Map<string, number>> {
  const result = await gitExecSafe(
    ["log", "--all", "--reverse", "--format=%at\x1f%s"],
    { cwd: projectDir, gitPath },
  );
  const map = new Map<string, number>();
  if (result.exitCode !== 0 || !result.stdout.trim()) return map;

  for (const line of result.stdout.trim().split("\n")) {
    const sep = line.indexOf("\x1f");
    if (sep === -1) continue;
    const epochStr = line.slice(0, sep);
    const subject = line.slice(sep + 1);
    const match = subject.match(/^\[([^\]]+)\] create$/);
    if (!match) continue;
    const assetId = match[1]!;
    if (!map.has(assetId)) {
      map.set(assetId, parseInt(epochStr, 10));
    }
  }

  return map;
}
