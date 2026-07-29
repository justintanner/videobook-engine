import type { ArtifactKind } from "./engine-types.js";

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "as", "is", "was", "are", "were", "been", "be",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "this", "that",
  "these", "those", "it", "its", "my", "your", "his", "her", "our", "their",
  "what", "which", "who", "whom", "whose", "where", "when", "why", "how",
  "all", "each", "every", "both", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too",
  "very", "just", "also",
]);

const KIND_PREFIXES = {
  video: "vid",
  image: "img",
  audio: "aud",
  script: "script",
  character: "char",
  prompt: "prompt",
  scene: "scene",
  final: "final",
} as const satisfies Record<ArtifactKind, string>;

export function isArtifactNameStopWord(word: string): boolean {
  return STOP_WORDS.has(word.toLowerCase());
}

export function artifactKindPrefix(kind: ArtifactKind): string {
  return KIND_PREFIXES[kind];
}

export function artifactNameSlug(
  kind: ArtifactKind,
  name: string,
  maxWords = 4,
): string {
  if (kind === "final") return "final";
  const prefix = artifactKindPrefix(kind);
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter((word) =>
      word.length > 0
      && word !== prefix
      && !isArtifactNameStopWord(word));
  const deduped: string[] = [];
  for (const word of words) {
    if (deduped.at(-1) !== word) deduped.push(word);
  }
  const slug = deduped.slice(0, Math.max(1, maxWords)).join("-");
  return `${prefix}-${slug || "untitled"}`;
}

export function humanizeArtifactSlug(slug: string): string {
  return slug
    .replace(/^[a-z]+-/, "")
    .split("-")
    .map((word) =>
      word.length === 0
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
