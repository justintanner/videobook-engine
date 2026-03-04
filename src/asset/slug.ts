import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'this', 'that',
  'these', 'those', 'it', 'its', 'my', 'your', 'his', 'her', 'our', 'their',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
  'very', 'just', 'also',
]);

export function slugifyName(name: string, prefix: string): string {
  // Lowercase, strip non-alnum, collapse
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/[\s-]+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));

  const slug = words.slice(0, 4).join('-');
  return slug ? `${prefix}-${slug}` : `${prefix}-untitled`;
}

export async function uniqueSlug(
  outputDir: string,
  baseSlug: string,
  historicalSlugs?: ReadonlySet<string>,
): Promise<string> {
  const MAX_ATTEMPTS = 1000;
  let candidate = baseSlug;
  let counter = 2;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (historicalSlugs?.has(candidate)) {
      candidate = `${baseSlug}-${counter}`;
      counter++;
      continue;
    }
    try {
      // Atomic mkdir (no recursive) — acts as both uniqueness check and reservation
      await fs.mkdir(path.join(outputDir, candidate));
      return candidate;
    } catch (error: unknown) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === 'EEXIST') {
        candidate = `${baseSlug}-${counter}`;
        counter++;
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Could not find unique slug after ${MAX_ATTEMPTS} attempts for: ${baseSlug}`);
}
