# Curly Agent Memory

## Modes
- **Plan review**: Invoked with plan file path. Append `## Curly's FP Review` to plan. Do NOT edit source.
- **Code review**: Invoked without plan file path. Use git diff, fix src/ files directly.

## Agent Scope
- Review `src/` files only, only files changed in the most recent commit
- Also review untracked `src/` files when user explicitly requests review of new implementation
- Fix simple violations directly, rewrite egregious cases
- Do not commit, run tests, or run linters

## Codebase Architecture

### Core Pattern: Result<T, EngineError>
- Public semantic APIs return a discriminated `Result<T, EngineError>`; runtime
  queue and lease primitives return direct values.
- Types and `ok`/`err` helpers live in `src/engine-types.ts`.
- Error codes include `NOT_FOUND`, `SLUG_CONFLICT`, `INVALID_INPUT`,
  `SCHEMA_INCOMPATIBLE`, `STALE_REVISION`, and `ACTION_CONFLICT`.

### Module Layout
- `src/books.ts` -- the one singleton Book per engine root
- `src/artifacts.ts`, `src/files.ts`, and `src/cas.ts` -- artifact lifecycle,
  content-addressed files, and workspace materialization
- `src/domain.ts`, `src/metadata.ts`, and `src/communications.ts` -- entities,
  notebook graph documents, metadata, prompts, and messages
- `src/schema.ts` and `src/store.ts` -- schema, Dolt staging/commits, and outbox
  recovery
- `src/history.ts` -- revisions, generic action graph records, and forward
  restores
- `src/runtime-services.ts`, `src/job-queue.ts`, and `src/status.ts` -- runtime
  coordination

### Key Patterns
- A new engine root requires `initialBookSlug`; existing roots reopen their
  stored book and do not overwrite it.
- All semantic state is scoped to that singleton Book. There are no project IDs
  or project tables.
- Every semantic mutation is a Dolt commit; `runtime_*` tables are never staged.
- Workspaces are `workspaceDir/<artifact UUID>/` and are disposable.
- Artifact slugs use canonical kind prefixes. There is no notebook artifact
  kind; notebook graphs remain under `engine.notebooks`.
- ESM package, Node.js >= 22.

## Common Patterns to Watch
- `let` where `const` suffices -- always flag
- Functions mixing computation with `execFile` calls -- extract pure computation
- `any` type annotations -- always flag, add specific types
- In-place array mutation where `.map()` would be clearer
