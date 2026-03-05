import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface PromptLogEntry {
  [key: string]: unknown;
}

export async function getPromptLog(
  projectDir: string,
  limit: number = 50,
): Promise<PromptLogEntry[]> {
  const logPath = path.join(projectDir, '.prompt_log.jsonl');

  let content: string;
  try {
    content = await fs.readFile(logPath, 'utf-8');
  } catch {
    return [];
  }

  const entries: PromptLogEntry[] = [];
  for (const line of content.trim().split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as PromptLogEntry);
    } catch {
      // skip malformed lines
    }
  }

  return entries.slice(-limit);
}
