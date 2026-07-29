import type {
  AppendMessageInput,
  EngineError,
  ListPromptHistoryArgs,
  Message,
  PromptHistoryEntry,
  RecordPromptArgs,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf, syncResultOf } from "./context.js";
import { canonicalJson, parseJson } from "./store.js";
import { newUuidV7 } from "./ids.js";

interface PromptRow {
  prompt_id: string;
  surface: string;
  prompt: string;
  context_json: string;
  created_at: number;
}

interface MessageRow {
  message_id: string;
  role: string;
  body_json: string;
  created_at: number;
}

export function createPromptsApi(context: EngineContext) {
  return {
    record: (
      input: RecordPromptArgs,
    ): Promise<Result<PromptHistoryEntry, EngineError>> =>
      recordPrompt(context, input),
    list: (
      options: ListPromptHistoryArgs = {},
    ): Result<PromptHistoryEntry[], EngineError> =>
      syncResultOf(() => listPrompts(context, options)),
    count: (
      options: Pick<ListPromptHistoryArgs, "surface"> = {},
    ): Result<number, EngineError> =>
      syncResultOf(() => countPrompts(context, options)),
  };
}

export function createMessagesApi(context: EngineContext) {
  return {
    append: <T extends Record<string, unknown>>(
      input: AppendMessageInput<T>,
    ): Promise<Result<Message<T>, EngineError>> => appendMessage(context, input),
    list: <T = Record<string, unknown>>(
      options: { limit?: number; role?: string } = {},
    ): Result<Message<T>[], EngineError> =>
      syncResultOf(() => listMessages<T>(context, options)),
  };
}

async function recordPrompt(
  context: EngineContext,
  input: RecordPromptArgs,
): Promise<Result<PromptHistoryEntry, EngineError>> {
  return resultOf(async () => {
    const surface = input.surface.trim();
    const prompt = input.prompt.trim();
    if (!surface || !prompt) {
      throw new Error("Prompt surface and prompt are required");
    }
    const promptId = newUuidV7();
    const mutation = await context.store.semantic(
      {
        operation: "record_prompt",
        details: { surface },
        writeSet: [`prompt:${promptId}`],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO prompt_entries(
              prompt_id, surface, prompt, context_json, created_at
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            promptId,
            surface,
            prompt,
            canonicalJson(input.context ?? {}),
            now,
          );
        return promptId;
      },
    );
    return ok(promptFromRow(requiredPrompt(context, mutation.value)), mutation.revision);
  });
}

function listPrompts(
  context: EngineContext,
  options: ListPromptHistoryArgs,
): PromptHistoryEntry[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.surface) {
    clauses.push("surface=?");
    params.push(options.surface);
  }
  params.push(Math.max(1, options.limit ?? 100));
  const rows = context.store.db
    .prepare(
      `SELECT prompt_id, surface, prompt, context_json, created_at
       FROM prompt_entries
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC, prompt_id DESC
       LIMIT ?`,
    )
    .all(...params) as unknown as PromptRow[];
  return rows.map(promptFromRow);
}

function countPrompts(
  context: EngineContext,
  options: Pick<ListPromptHistoryArgs, "surface">,
): number {
  const row = options.surface
    ? (context.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM prompt_entries WHERE surface=?",
        )
        .get(options.surface) as unknown as { count: number })
    : (context.store.db
        .prepare("SELECT COUNT(*) AS count FROM prompt_entries")
        .get() as unknown as { count: number });
  return row.count;
}

async function appendMessage<T extends Record<string, unknown>>(
  context: EngineContext,
  input: AppendMessageInput<T>,
): Promise<Result<Message<T>, EngineError>> {
  return resultOf(async () => {
    const role = input.role.trim();
    if (!role) throw new Error("Message role is required");
    const messageId = newUuidV7();
    const mutation = await context.store.semantic(
      {
        operation: "append_message",
        details: { messageId, role },
        writeSet: [`message:${messageId}`],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO messages(message_id, role, body_json, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(messageId, role, canonicalJson(input.body), now);
      },
    );
    return ok(messageFromRow<T>(requiredMessage(context, messageId)), mutation.revision);
  });
}

function listMessages<T>(
  context: EngineContext,
  options: { limit?: number; role?: string },
): Message<T>[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.role) {
    clauses.push("role=?");
    params.push(options.role);
  }
  params.push(Math.max(1, options.limit ?? 100));
  const rows = context.store.db
    .prepare(
      `SELECT message_id, role, body_json, created_at
       FROM messages
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC, message_id DESC
       LIMIT ?`,
    )
    .all(...params) as unknown as MessageRow[];
  return rows.reverse().map(messageFromRow<T>);
}

function requiredPrompt(context: EngineContext, promptId: string): PromptRow {
  const row = context.store.db
    .prepare(
      `SELECT prompt_id, surface, prompt, context_json, created_at
       FROM prompt_entries WHERE prompt_id=?`,
    )
    .get(promptId) as unknown as PromptRow | undefined;
  if (!row) throw new Error(`Prompt not found after insert: ${promptId}`);
  return row;
}

function requiredMessage(context: EngineContext, messageId: string): MessageRow {
  const row = context.store.db
    .prepare(
      `SELECT message_id, role, body_json, created_at
       FROM messages WHERE message_id=?`,
    )
    .get(messageId) as unknown as MessageRow | undefined;
  if (!row) throw new Error(`Message not found after insert: ${messageId}`);
  return row;
}

function promptFromRow(row: PromptRow): PromptHistoryEntry {
  return {
    id: row.prompt_id,
    surface: row.surface,
    prompt: row.prompt,
    context: parseJson(row.context_json, {}),
    createdAt: row.created_at,
  };
}

function messageFromRow<T>(row: MessageRow): Message<T> {
  return {
    messageId: row.message_id,
    role: row.role,
    body: parseJson<T>(row.body_json, {} as T),
    createdAt: row.created_at,
  };
}
