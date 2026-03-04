import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ProjectMetadata, FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { PROJECT_METADATA, DEFAULT_PROJECT_FILE } from '../constants.js';
import { initProjectRepo } from '../git/init.js';
import { generateProjectSlug } from './slug.js';

export async function createProject(
  outputDir: string,
  slug?: string,
  gitPath?: string,
): Promise<Result<{ slug: string; path: string; is_default: boolean }, FsError>> {
  const projectSlug = slug ?? await generateProjectSlug(outputDir);
  const projectDir = path.join(outputDir, projectSlug);

  await fs.mkdir(projectDir, { recursive: true });

  // Write .project metadata
  const metadata: ProjectMetadata = {
    slug: projectSlug,
    created: Date.now() / 1000,
  };
  await fs.writeFile(
    path.join(projectDir, PROJECT_METADATA),
    JSON.stringify(metadata, null, 2),
  );

  // Initialize git repo
  await initProjectRepo(projectDir, gitPath);

  // Check if this becomes the default
  const defaultFile = path.join(outputDir, DEFAULT_PROJECT_FILE);
  let isDefault = false;
  try {
    await fs.access(defaultFile);
  } catch {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(defaultFile, projectSlug);
    isDefault = true;
  }

  return ok({ slug: projectSlug, path: projectDir, is_default: isDefault });
}
