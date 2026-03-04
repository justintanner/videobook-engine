import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ProjectMetadata, FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { PROJECT_METADATA } from '../constants.js';
import { initProjectRepo } from '../git/init.js';
import { getDefaultProject } from './switch.js';

export async function getProject(
  outputDir: string,
  slug?: string,
  gitPath?: string,
): Promise<Result<{ metadata: ProjectMetadata; path: string }, FsError>> {
  const projectSlug = slug ?? await getDefaultProject(outputDir);
  if (!projectSlug) {
    return err({ code: 'NOT_FOUND', message: 'No default project set' });
  }

  // Normalize: extract just the slug name if a path was passed
  const normalizedSlug = projectSlug.includes('/') ? path.basename(projectSlug) : projectSlug;
  const projectDir = path.join(outputDir, normalizedSlug);

  try {
    await fs.access(projectDir);
  } catch {
    return err({ code: 'NOT_FOUND', message: `Project not found: ${normalizedSlug}` });
  }

  // Ensure .project metadata exists
  const metadataFile = path.join(projectDir, PROJECT_METADATA);
  let metadata: ProjectMetadata;
  try {
    const content = await fs.readFile(metadataFile, 'utf-8');
    metadata = JSON.parse(content) as ProjectMetadata;
  } catch {
    metadata = { slug: normalizedSlug, created: Date.now() / 1000 };
    await fs.writeFile(metadataFile, JSON.stringify(metadata, null, 2));
  }

  // Ensure git repo is initialized
  await initProjectRepo(projectDir, gitPath);

  return ok({ metadata, path: projectDir });
}

export async function resolveProjectDir(
  outputDir: string,
  slug?: string,
  gitPath?: string,
): Promise<string | null> {
  const result = await getProject(outputDir, slug, gitPath);
  return result.ok ? result.value.path : null;
}
