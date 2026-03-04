import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ErrorData {
  error: string;
  error_type: string;
  failed_at: number;
  [key: string]: unknown;
}

export async function writeErrorFile(
  dir: string,
  errorFileName: string,
  errorMessage: string,
  errorType: string = 'api_error',
  extra?: Record<string, unknown>,
): Promise<string> {
  const errorPath = path.join(dir, errorFileName);

  const errorData: ErrorData = {
    error: errorMessage,
    error_type: errorType,
    failed_at: Date.now() / 1000,
    ...extra,
  };

  await fs.writeFile(errorPath, JSON.stringify(errorData, null, 2));
  return errorPath;
}

export async function readErrorFile(
  dir: string,
  errorFileName: string,
): Promise<ErrorData | null> {
  const errorPath = path.join(dir, errorFileName);
  try {
    const content = await fs.readFile(errorPath, 'utf-8');
    return JSON.parse(content) as ErrorData;
  } catch {
    return null;
  }
}
