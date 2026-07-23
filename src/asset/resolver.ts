/**
 * Reusable @tag parsing & resolution for asset references in prompts.
 */
import type { VideocityFs } from "../index.js";
import type { AssetType } from "../types.js";
import { getStateDb } from "../db/client.js";

type ResolvedAsset = {
  tag: string;         // "@img-sunset"
  asset_id: string;    // "img-sunset"
  asset_type: AssetType;
  file_path: string | null;
  asset_dir: string;
};

const TAG_PATTERN = /@([a-zA-Z0-9]+-[a-zA-Z0-9_-]+)/g;

function parseAssetTags(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(TAG_PATTERN)) {
    if (m[1]) ids.push(m[1]);
  }
  return [...new Set(ids)];
}

async function resolveAllAssets(
  text: string,
  fs: VideocityFs,
  projectSlug: string,
): Promise<{ resolved: ResolvedAsset[]; unresolved: string[] }> {
  const tags = parseAssetTags(text);
  if (tags.length === 0) return { resolved: [], unresolved: [] };

  const slug = projectSlug;
  const allAssets = await fs.listAssets(slug);

  const assetIds = new Set(allAssets.map((a) => a.id));

  const resolved: ResolvedAsset[] = [];
  const unresolved: string[] = [];

  for (const tag of tags) {
    // Try exact match first, then prefixed variants
    const candidates = [
      tag,
      `img-${tag}`,
      `vid-${tag}`,
      `aud-${tag}`,
      `script-${tag}`,
      `char-${tag}`,
      `prm-${tag}`,
      `scn-${tag}`,
      `nb-${tag}`,
    ];
    let matchedId = candidates.find((c) => assetIds.has(c));
    if (!matchedId) {
      const projectDir = await fs.resolveProjectDir(projectSlug);
      if (projectDir) {
        try {
          const db = getStateDb(projectDir);
          for (const c of candidates) {
            const row = db.prepare("SELECT current_asset_id FROM asset_aliases WHERE old_asset_id = ?").get(c) as { current_asset_id: string } | undefined;
            if (row && assetIds.has(row.current_asset_id)) {
              matchedId = row.current_asset_id;
              break;
            }
          }
        } catch (e) {}
      }
    }

    if (!matchedId) {
      unresolved.push(tag);
      continue;
    }

    const entry = allAssets.find((a) => a.id === matchedId)!;
    let filePath: string | null = null;

    const manifest = await fs.getManifest(matchedId, slug);
    if (manifest.ok) {
      const original = manifest.value.files.find((f) => f.name.startsWith("original"));
      const firstFile = original ?? manifest.value.files[0];
      if (firstFile) {
        filePath = `${manifest.value.path}/${firstFile.name}`;
      }
    }

    resolved.push({
      tag: `@${tag}`,
      asset_id: matchedId,
      asset_type: entry.type,
      file_path: filePath,
      asset_dir: entry.path,
    });
  }

  return { resolved, unresolved };
}

const SLOT_PATTERN = /@s(\d{2})/g;

function expandSlotRefs(
  text: string,
  slots: Array<{ slug: string }>,
): string {
  return text.replace(SLOT_PATTERN, (match, digits) => {
    const index = parseInt(digits, 10) - 1;
    const slot = slots[index];
    if (slot && slot.slug) {
      return `@${slot.slug}`;
    }
    return match;
  });
}

export { parseAssetTags, resolveAllAssets, expandSlotRefs };
export type { ResolvedAsset };
