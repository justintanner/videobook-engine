import type { Book, EngineError, Result } from "./engine-types.js";
import { ok } from "./engine-types.js";
import {
  EngineContext,
  normalizeBookSlug,
  resultOf,
} from "./context.js";

export function createBookApi(context: EngineContext) {
  return {
    get: (): Book => context.book(),
    rename: (slug: string): Promise<Result<Book, EngineError>> =>
      renameBook(context, slug),
  };
}

async function renameBook(
  context: EngineContext,
  requestedSlug: string,
): Promise<Result<Book, EngineError>> {
  return resultOf(async () => {
    const current = context.bookRow();
    const slug = normalizeBookSlug(requestedSlug);
    if (current.slug === slug) return context.book(current);
    const mutation = await context.store.semantic(
      {
        operation: "rename_book",
        tables: ["book"],
        details: { oldSlug: current.slug, newSlug: slug },
        writeSet: ["book", `book-slug:${current.slug}`, `book-slug:${slug}`],
      },
      () => {
        context.store.db
          .prepare("UPDATE book SET slug=? WHERE book_id=?")
          .run(slug, current.book_id);
      },
    );
    return ok(context.book(), mutation.revision);
  });
}
