/** Shared validation for new analysis and portable automatic evidence. */
import { EngineFault } from "./store.js";
import {
  AUTOMATIC_TAGS_PER_SNAPSHOT_MAX,
  normalizeTagList,
  type TagInput,
} from "./tag-values.js";

export function normalizeAutomaticTags(input: {
  sourceHash: string;
  generator: string;
  model?: string;
  extractorVersion: string;
  tags: readonly TagInput[];
}) {
  const sourceHash = requiredText(input.sourceHash, "sourceHash").toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(sourceHash)) {
    throw new Error("Automatic tag sourceHash must be a hex sha256 content hash");
  }
  const generator = requiredText(input.generator, "generator");
  const extractorVersion = requiredText(input.extractorVersion, "extractorVersion");
  if (input.model !== undefined && typeof input.model !== "string") {
    throw new Error("Automatic tag model must be a string");
  }
  const model = input.model?.trim();
  if (!Array.isArray(input.tags)) throw new Error("Automatic tags must be an array");
  const tags = normalizeTagList(input.tags);
  if (tags.some((tag) => tag.facet === "custom")) {
    throw new Error("Automatic tag facets must be people, places or editing; custom tags are manual");
  }
  if (tags.length > AUTOMATIC_TAGS_PER_SNAPSHOT_MAX) {
    throw new EngineFault({
      code: "RESOURCE_EXHAUSTED",
      message: `An automatic snapshot carries at most ${AUTOMATIC_TAGS_PER_SNAPSHOT_MAX} tags; received ${tags.length}`,
      details: { requested: tags.length, limit: AUTOMATIC_TAGS_PER_SNAPSHOT_MAX },
    });
  }
  return { sourceHash, generator, ...(model ? { model } : {}), extractorVersion, tags };
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Automatic tag ${field} is required`);
  }
  return value.trim();
}
