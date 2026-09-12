export const BOOK_SLUG_ERROR = "Project slugs must contain at least one letter (a-z) or number (0-9)";

export function normalizeBookSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
