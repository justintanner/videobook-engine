import type { Book, EngineError, Result } from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf } from "./context.js";
import { EngineFault } from "./store.js";

export function createBookApi(context: EngineContext) {
  return {
    get: (): Book => context.book(),
    rename: (name: string): Promise<Result<Book, EngineError>> =>
      renameBook(context, name),
  };
}

async function renameBook(
  context: EngineContext,
  requestedName: string,
): Promise<Result<Book, EngineError>> {
  return resultOf(async () => {
    const current = context.bookRow();
    const name = requestedName.trim();
    if (!name) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "Book name must be non-empty",
      });
    }
    if (current.name === name) return context.book(current);
    const mutation = await context.store.semantic(
      {
        operation: "rename_book",
        tables: ["book"],
        details: { oldName: current.name, newName: name },
        writeSet: ["book"],
      },
      () => {
        context.store.db
          .prepare("UPDATE book SET name=? WHERE book_id=?")
          .run(name, current.book_id);
      },
    );
    return ok(context.book(), mutation.revision);
  });
}
