import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const ADJECTIVES = [
  'dancing', 'frisky', 'grumpy', 'happy', 'jazzy', 'lazy', 'mighty',
  'noble', 'quirky', 'sneaky', 'witty', 'zany', 'bouncy', 'clever',
  'dizzy', 'fancy', 'giddy', 'humble', 'jolly', 'keen',
];

const NOUNS = [
  'banana', 'cactus', 'dolphin', 'falcon', 'gopher', 'hamster', 'iguana',
  'jaguar', 'koala', 'lemur', 'mango', 'narwhal', 'octopus', 'panda',
  'quokka', 'raccoon', 'salmon', 'turtle', 'urchin', 'vulture',
];

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

export async function generateProjectSlug(outputDir: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const adj = randomChoice(ADJECTIVES);
    const noun = randomChoice(NOUNS);
    const num = Math.floor(Math.random() * 90) + 10;
    const slug = `${adj}-${noun}-${num}`;

    try {
      await fs.access(path.join(outputDir, slug));
      // exists, try again
    } catch {
      return slug;
    }
  }

  // Fallback with timestamp
  const ts = Date.now() % 10000;
  return `${randomChoice(ADJECTIVES)}-${randomChoice(NOUNS)}-${ts}`;
}

export function isProjectSlug(name: string): boolean {
  if (!name || name.startsWith('.')) return false;
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(name);
}

/**
 * Public alias for `isProjectSlug` — the strict validator used by project
 * creation. Lowercase letters, digits, and internal hyphens only.
 *
 * Use this to validate untrusted project slugs at API boundaries (e.g. before
 * routing a queue payload to a per-project SQLite file).
 */
export function isValidProjectSlug(slug: string): boolean {
  return isProjectSlug(slug);
}
