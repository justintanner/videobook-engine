import type { FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { acquireLock } from './acquire.js';
import { releaseLock } from './release.js';
import {
  LOCK_TRANSCRIBING,
  LOCK_GENERATING,
  LOCK_RENDERING_LANDSCAPE,
  LOCK_RENDERING_PORTRAIT,
  LOCK_RENDERING_SQUARE,
  LOCK_DOWNLOADING,
  LOCK_ISOLATING,
  LOCK_TRIMMING,
  LOCK_SPEED_CHANGE,
  LOCK_REVERSING,
  LOCK_TIMELINE,
  LOCK_ANALYZING,
} from '../constants.js';

const LOCK_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  [LOCK_TRANSCRIBING, 'transcription in progress'],
  [LOCK_GENERATING, 'generation in progress'],
  [LOCK_RENDERING_LANDSCAPE, 'landscape rendering in progress'],
  [LOCK_RENDERING_PORTRAIT, 'portrait rendering in progress'],
  [LOCK_RENDERING_SQUARE, 'square rendering in progress'],
  [LOCK_DOWNLOADING, 'download in progress'],
  [LOCK_ISOLATING, 'isolation in progress'],
  [LOCK_TRIMMING, 'trimming in progress'],
  [LOCK_SPEED_CHANGE, 'speed change in progress'],
  [LOCK_REVERSING, 'reversing in progress'],
  [LOCK_TIMELINE, 'timeline in progress'],
  [LOCK_ANALYZING, 'analysis in progress'],
]);

const ALL_LOCKS = [...LOCK_DESCRIPTIONS.keys()];

export async function acquireAllLocks(
  assetDir: string,
): Promise<Result<string[], FsError>> {
  const acquired: string[] = [];

  for (const lock of ALL_LOCKS) {
    const result = await acquireLock(assetDir, lock);
    if (!result.ok) {
      // Release all acquired locks
      for (const held of acquired) {
        await releaseLock(assetDir, held);
      }
      if (result.error.code === 'LOCK_HELD') {
        const desc = LOCK_DESCRIPTIONS.get(lock) ?? lock;
        return err({ code: 'LOCKED', message: `Cannot proceed: ${desc}` });
      }
      return result;
    }
    acquired.push(lock);
  }

  return ok(acquired);
}

export async function releaseAllLocks(
  assetDir: string,
): Promise<void> {
  for (const lock of ALL_LOCKS) {
    await releaseLock(assetDir, lock);
  }
}
