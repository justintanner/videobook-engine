import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ProjectMetadata } from '../types.js';
import { PROJECT_METADATA, DEFAULT_PROJECT_FILE } from '../constants.js';
import { isProjectSlug } from './slug.js';

export async function listProjects(outputDir: string): Promise<ProjectMetadata[]> {
  try {
    await fs.access(outputDir);
  } catch {
    return [];
  }

  let defaultSlug: string | null = null;
  try {
    defaultSlug = (await fs.readFile(path.join(outputDir, DEFAULT_PROJECT_FILE), 'utf-8')).trim();
  } catch {
    // No default file
  }

  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const projects: ProjectMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !isProjectSlug(entry.name)) continue;

    const metadataFile = path.join(outputDir, entry.name, PROJECT_METADATA);
    try {
      const content = await fs.readFile(metadataFile, 'utf-8');
      const metadata = JSON.parse(content) as ProjectMetadata;
      const stat = await fs.stat(metadataFile);
      metadata.path = path.join(outputDir, entry.name);
      metadata.is_default = entry.name === defaultSlug;
      metadata.last_activity = stat.mtimeMs / 1000;
      projects.push(metadata);
    } catch {
      // Skip entries without valid .project metadata
    }
  }

  projects.sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0));
  return projects;
}
