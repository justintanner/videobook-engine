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
import { scanNotebookMentions } from "./notebook-mentions.js";

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
  return [...new Set(
    scanNotebookMentions(text)
      .filter((mention) => mention.kind === "asset-slug")
      .map((mention) => mention.reference),
  )];
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
        `SELECT artifact_id, slug, kind, created_at
         FROM artifacts`,
      )
      .all() as unknown as Array<{
      artifact_id: string;
      slug: string;
      kind: ResolvedArtifact["artifactType"];
      created_at: number;
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
