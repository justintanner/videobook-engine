import type {
  EngineError,
  Generation,
  GenerationPatch,
  GenerationStatus,
  ListGenerationsArgs,
  RecordGenerationArgs,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf, syncResultOf } from "./context.js";
import { assertUuidV7, newUuidV7 } from "./ids.js";

const GENERATION_STATUSES: readonly GenerationStatus[] = [
  "dispatched",
  "awaiting_provider",
  "completed",
  "failed",
];

const GENERATION_COLUMNS = `
  generation_id, notebook_id, cell_id, output_cell_id, run_id,
  status, tool, provider, model, prompt, resolved_prompt,
  provider_artifact_id, output_artifact_id, error, created_at, updated_at
`;

interface GenerationRow {
  generation_id: string;
  notebook_id: string;
  cell_id: string;
  output_cell_id: string | null;
  run_id: string | null;
  status: GenerationStatus;
  tool: string;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  resolved_prompt: string | null;
  provider_artifact_id: string | null;
  output_artifact_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export function createGenerationsApi(context: EngineContext) {
  return {
    record: (
      input: RecordGenerationArgs,
    ): Promise<Result<Generation, EngineError>> =>
      recordGeneration(context, input),
    update: (
      generationId: string,
      patch: GenerationPatch,
    ): Promise<Result<Generation, EngineError>> =>
      updateGeneration(context, generationId, patch),
    listForCell: (
      notebookId: string,
      cellId: string,
      options: ListGenerationsArgs = {},
    ): Result<Generation[], EngineError> =>
      syncResultOf(() =>
        listGenerationsForCell(context, notebookId, cellId, options),
      ),
    read: (generationId: string): Result<Generation, EngineError> =>
      syncResultOf(() =>
        generationFromRow(requiredGeneration(context, generationId)),
      ),
  };
}

async function recordGeneration(
  context: EngineContext,
  input: RecordGenerationArgs,
): Promise<Result<Generation, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(input.notebookId, "Notebook ID");
    assertUuidV7(input.cellId, "Cell ID");
    const tool = input.tool.trim();
    if (!tool) {
      throw new Error("Generation tool is required");
    }
    const status = input.status ?? "dispatched";
    assertGenerationStatus(status);
    requireCell(context, input.notebookId, input.cellId);
    const generationId = newUuidV7();
    const artifactId = input.providerArtifactId ?? input.outputArtifactId;
    const mutation = await context.store.semantic(
      {
        operation: "record_generation",
        tables: ["generations"],
        ...(artifactId ? { artifactId } : {}),
        details: {
          generationId,
          notebookId: input.notebookId,
          cellId: input.cellId,
          tool,
          status,
        },
        writeSet: [`generation:${generationId}`],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO generations(
              generation_id, notebook_id, cell_id, output_cell_id, run_id,
              status, tool, provider, model, prompt, resolved_prompt,
              provider_artifact_id, output_artifact_id, error,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            generationId,
            input.notebookId,
            input.cellId,
            input.outputCellId ?? null,
            input.runId ?? null,
            status,
            tool,
            input.provider ?? null,
            input.model ?? null,
            input.prompt ?? null,
            input.resolvedPrompt ?? null,
            input.providerArtifactId ?? null,
            input.outputArtifactId ?? null,
            now,
            now,
          );
      },
    );
    return ok(
      generationFromRow(requiredGeneration(context, generationId)),
      mutation.revision,
    );
  });
}

async function updateGeneration(
  context: EngineContext,
  generationId: string,
  patch: GenerationPatch,
): Promise<Result<Generation, EngineError>> {
  return resultOf(async () => {
    assertUuidV7(generationId, "Generation ID");
    if (patch.status !== undefined) assertGenerationStatus(patch.status);
    const current = requiredGeneration(context, generationId);
    const next: GenerationRow = {
      ...current,
      output_cell_id: patchField(patch.outputCellId, current.output_cell_id),
      run_id: patchField(patch.runId, current.run_id),
      status: patch.status ?? current.status,
      provider: patchField(patch.provider, current.provider),
      model: patchField(patch.model, current.model),
      prompt: patchField(patch.prompt, current.prompt),
      resolved_prompt: patchField(
        patch.resolvedPrompt,
        current.resolved_prompt,
      ),
      provider_artifact_id: patchField(
        patch.providerArtifactId,
        current.provider_artifact_id,
      ),
      output_artifact_id: patchField(
        patch.outputArtifactId,
        current.output_artifact_id,
      ),
      error: patchField(patch.error, current.error),
    };
    const artifactId = next.output_artifact_id ?? next.provider_artifact_id;
    const mutation = await context.store.semantic(
      {
        operation: generationTransition(next.status),
        tables: ["generations"],
        ...(artifactId ? { artifactId } : {}),
        details: {
          generationId,
          notebookId: next.notebook_id,
          cellId: next.cell_id,
          status: next.status,
        },
        writeSet: [`generation:${generationId}`],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `UPDATE generations SET
              output_cell_id=?, run_id=?, status=?, provider=?, model=?,
              prompt=?, resolved_prompt=?, provider_artifact_id=?,
              output_artifact_id=?, error=?, updated_at=?
            WHERE generation_id=?`,
          )
          .run(
            next.output_cell_id,
            next.run_id,
            next.status,
            next.provider,
            next.model,
            next.prompt,
            next.resolved_prompt,
            next.provider_artifact_id,
            next.output_artifact_id,
            next.error,
            now,
            generationId,
          );
      },
    );
    return ok(
      generationFromRow(requiredGeneration(context, generationId)),
      mutation.revision,
    );
  });
}

function generationTransition(status: GenerationStatus): string {
  if (status === "completed") return "complete_generation";
  if (status === "failed") return "fail_generation";
  return "update_generation";
}

function listGenerationsForCell(
  context: EngineContext,
  notebookId: string,
  cellId: string,
  options: ListGenerationsArgs,
): Generation[] {
  assertUuidV7(notebookId, "Notebook ID");
  assertUuidV7(cellId, "Cell ID");
  const rows = context.store.db
    .prepare(
      `SELECT ${GENERATION_COLUMNS}
       FROM generations
       WHERE notebook_id=? AND cell_id=?
       ORDER BY created_at DESC, generation_id DESC
       LIMIT ?`,
    )
    .all(notebookId, cellId, Math.max(1, options.limit ?? 100)) as unknown as
    GenerationRow[];
  return rows.map(generationFromRow);
}

function requireCell(
  context: EngineContext,
  notebookId: string,
  cellId: string,
): void {
  const row = context.store.db
    .prepare(
      "SELECT 1 AS present FROM cells WHERE notebook_id=? AND cell_id=?",
    )
    .get(notebookId, cellId);
  if (!row) throw new Error(`Cell not found: ${cellId}`);
}

function requiredGeneration(
  context: EngineContext,
  generationId: string,
): GenerationRow {
  const row = context.store.db
    .prepare(
      `SELECT ${GENERATION_COLUMNS}
       FROM generations WHERE generation_id=?`,
    )
    .get(generationId) as unknown as GenerationRow | undefined;
  if (!row) throw new Error(`Generation not found: ${generationId}`);
  return row;
}

function patchField(
  patch: string | null | undefined,
  current: string | null,
): string | null {
  return patch === undefined ? current : patch;
}

function assertGenerationStatus(status: string): void {
  if (!(GENERATION_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Invalid generation status: ${status}`);
  }
}

function generationFromRow(row: GenerationRow): Generation {
  return {
    generationId: row.generation_id,
    notebookId: row.notebook_id,
    cellId: row.cell_id,
    ...(row.output_cell_id === null
      ? {}
      : { outputCellId: row.output_cell_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    status: row.status,
    tool: row.tool,
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.prompt === null ? {} : { prompt: row.prompt }),
    ...(row.resolved_prompt === null
      ? {}
      : { resolvedPrompt: row.resolved_prompt }),
    ...(row.provider_artifact_id === null
      ? {}
      : { providerArtifactId: row.provider_artifact_id }),
    ...(row.output_artifact_id === null
      ? {}
      : { outputArtifactId: row.output_artifact_id }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
