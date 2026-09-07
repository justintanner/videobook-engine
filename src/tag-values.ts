/**
 * Asset-tag values: normalization, identity and the documented limits.
 *
 * Deliberately dependency-free and side-effect-free so the same rules can
 * run in a browser client before a write reaches the engine. Semantic tag
 * identity is the pair (facet, canonical key) — never the display label
 * alone — so the same word carried by two facets stays distinct.
 */

export const TAG_FACETS = ["people", "places", "editing", "custom"] as const;

export type TagFacet = (typeof TAG_FACETS)[number];

export type TagOrigin = "manual" | "automatic";

/** Display labels are capped in Unicode code points, not UTF-16 units. */
export const TAG_LABEL_MAX_CODE_POINTS = 64;

/** Manual assignments a single artifact may carry. */
export const MANUAL_TAGS_PER_ARTIFACT_MAX = 100;

/** Automatic assignments one analysis snapshot may carry. */
export const AUTOMATIC_TAGS_PER_SNAPSHOT_MAX = 12;

/**
 * Durable dismissals a single artifact may carry. Dismissals record user
 * intent, so the ceiling refuses the write instead of silently dropping
 * the oldest suppression.
 */
export const TAG_DISMISSALS_PER_ARTIFACT_MAX = 500;

export interface TagInput {
  facet: TagFacet;
  label: string;
  /** An already-confirmed entity; never minted from a model guess. */
  entityId?: string;
}

export interface TagIdentityInput {
  facet: TagFacet;
  label: string;
}

export interface NormalizedTag {
  facet: TagFacet;
  key: string;
  label: string;
  entityId?: string;
}

const CONTROL_CHARACTER = /\p{Cc}/u;

export function isTagFacet(value: string): value is TagFacet {
  return (TAG_FACETS as readonly string[]).includes(value);
}

export function assertTagFacet(value: string): TagFacet {
  if (!isTagFacet(value)) {
    throw new Error(
      `Tag facet must be one of ${TAG_FACETS.join(", ")}; received ${value}`,
    );
  }
  return value;
}

/**
 * NFKC, whitespace-collapsed, trimmed display label. Control characters
 * that survive whitespace collapsing are rejected rather than stripped, so
 * a caller never silently stores something other than what it sent.
 */
export function normalizeTagLabel(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Tag label is required");
  }
  const label = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!label) throw new Error("Tag label is required");
  if (CONTROL_CHARACTER.test(label)) {
    throw new Error("Tag label must not contain control characters");
  }
  const codePoints = [...label].length;
  if (codePoints > TAG_LABEL_MAX_CODE_POINTS) {
    throw new Error(
      `Tag label must be at most ${TAG_LABEL_MAX_CODE_POINTS} characters; received ${codePoints}`,
    );
  }
  return label;
}

/** Stable, locale-independent canonical key for a normalized label. */
export function tagCanonicalKey(label: string): string {
  return normalizeTagLabel(label).toLowerCase();
}

/**
 * Prefix form of a label for autocomplete: the same NFKC, whitespace, trim
 * and case rules as a key, so what a user types matches what was stored.
 * An empty prefix is a legitimate "no filter" rather than an error.
 */
export function normalizeTagPrefix(value: string): string {
  const prefix = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (CONTROL_CHARACTER.test(prefix)) {
    throw new Error("Tag prefix must not contain control characters");
  }
  if ([...prefix].length > TAG_LABEL_MAX_CODE_POINTS) {
    throw new Error(
      `Tag prefix must be at most ${TAG_LABEL_MAX_CODE_POINTS} characters`,
    );
  }
  return prefix.toLowerCase();
}

export function tagIdentity(facet: TagFacet, key: string): string {
  return `${facet}:${key}`;
}

export function normalizeTagIdentity(input: TagIdentityInput): {
  facet: TagFacet;
  key: string;
  label: string;
} {
  const facet = assertTagFacet(input.facet);
  const label = normalizeTagLabel(input.label);
  return { facet, key: label.toLowerCase(), label };
}

export function normalizeTag(input: TagInput): NormalizedTag {
  const { facet, key, label } = normalizeTagIdentity(input);
  const entityId = input.entityId?.trim();
  return {
    facet,
    key,
    label,
    ...(entityId ? { entityId } : {}),
  };
}

/**
 * Normalizes a list and drops later duplicates of an identity already
 * seen, so a caller's repeated word never becomes a repeated chip.
 */
export function normalizeTagList(inputs: readonly TagInput[]): NormalizedTag[] {
  const seen = new Set<string>();
  const tags: NormalizedTag[] = [];
  for (const input of inputs) {
    const tag = normalizeTag(input);
    const identity = tagIdentity(tag.facet, tag.key);
    if (seen.has(identity)) continue;
    seen.add(identity);
    tags.push(tag);
  }
  return tags;
}
