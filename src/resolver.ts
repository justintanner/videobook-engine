import * as path from "node:path";

import type {
  EngineError,
  ResolvedArtifact,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf } from "./context.js";
import { createFilesApi } from "./files.js";
import { findPrimaryMediaFile } from "./media.js";

const TAG_PATTERN = /@([a-zA-Z0-9]+-[a-zA-Z0-9_-]+)/g;
const SLOT_PATTERN = /@s(\d{2})/g;

export function createResolverApi(context: EngineContext) {
  return {
    parseTags: parseArtifactTags,
    resolveAll: (
      text: string,
    ): Promise<
      Result<
        { resolved: ResolvedArtifact[]; unresolved: string[] },
        EngineError
      >
    > => resolveAllArtifacts(context, text),
    expandSlotRefs,
  };
}

export function parseArtifactTags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(TAG_PATTERN)) {
    if (match[1]) tags.push(match[1]);
  }
  return [...new Set(tags)];
}

export function expandSlotRefs(
  text: string,
  slots: Array<{ slug: string }>,
): string {
  return text.replace(SLOT_PATTERN, (match, digits: string) => {
    const slot = slots[Number.parseInt(digits, 10) - 1];
    return slot?.slug ? `@${slot.slug}` : match;
  });
}

async function resolveAllArtifacts(
  context: EngineContext,
  text: string,
): Promise<
  Result<
    { resolved: ResolvedArtifact[]; unresolved: string[] },
    EngineError
  >
> {
  return resultOf(async () => {
    const tags = parseArtifactTags(text);
    if (tags.length === 0) {
      return ok({ resolved: [], unresolved: [] });
    }
    const rows = context.store.db
      .prepare(
        `SELECT artifact_id, slug, kind, data_json,
                created_at, updated_at, deleted_at
         FROM artifacts
         WHERE deleted_at IS NULL`,
      )
      .all() as unknown as Array<{
      artifact_id: string;
      slug: string;
      kind: ResolvedArtifact["artifactType"];
      data_json: string;
      created_at: number;
      updated_at: number;
      deleted_at: null;
    }>;
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    const files = createFilesApi(context);
    const resolved: ResolvedArtifact[] = [];
    const unresolved: string[] = [];

    for (const tag of tags) {
      const candidates = [
        tag,
        `img-${tag}`,
        `vid-${tag}`,
        `aud-${tag}`,
        `script-${tag}`,
        `char-${tag}`,
        `prompt-${tag}`,
        `scene-${tag}`,
      ];
      const row = candidates
        .map((candidate) => bySlug.get(candidate))
        .find((candidate) => candidate !== undefined);
      if (!row) {
        unresolved.push(tag);
        continue;
      }
      const manifest = await files.manifest(row.artifact_id);
      if (!manifest.ok) return manifest;
      const primary =
        findPrimaryMediaFile(manifest.value.files, row.slug) ??
        manifest.value.files[0] ??
        null;
      resolved.push({
        tag: `@${tag}`,
        artifactId: row.artifact_id,
        artifactSlug: row.slug,
        artifactType: row.kind,
        filePath: primary
          ? path.join(manifest.value.path, primary.name)
          : null,
        workspacePath: manifest.value.path,
      });
    }
    return ok({ resolved, unresolved });
  });
}
