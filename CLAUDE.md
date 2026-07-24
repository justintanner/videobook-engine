# CLAUDE.md

## Project

`videobook-engine` is an ESM TypeScript package for Node.js 22+. Catalog
schema v4 is Dolt-native and deliberately has no compatibility or migration
layer for v3, the former multi-project catalog, or the earlier
Git/project-directory/SQLite-sidecar engine.

## Commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run examples
npx knip
```

## Architecture

`src/engine.ts` exports the `createEngine(config)` factory and the namespaced
`Engine` API. A new catalog requires `initialBookSlug`; subsequent opens use
the singleton book stored in the catalog. Configuration accepts either
`rootDir` or separate `dataDir` and `workspaceDir` paths. The `book` table has
one stable UUIDv7 row; it does not use a synthetic singleton column.

- `dataDir/videobook.db` is the only database.
- Semantic and runtime tables share that database.
- Semantic tables are explicitly allowlisted, staged, and committed to Dolt.
- `runtime_*` tables are covered by the committed `dolt_ignore` policy and are
  never staged or versioned.
- `dataDir/objects/sha256/` is the immutable local content-addressed store.
- `workspaceDir/<artifact UUID>/` is disposable materialization.
- Book, artifact, entity, notebook, cell, edge, run, prompt, message, action,
  timeline-slot, and timeline-audio surrogate identities are UUIDv7 values.
- Deletes are hard deletes. Owned children cascade; referenced live artifacts
  and entities return `IN_USE`; immutable CAS objects and Dolt history remain.
- Timeline state is normalized across `timeline`, `timeline_slots`, and
  `timeline_audio` and is only exposed through `engine.timeline`.
- Restores are forward-only commits. The engine never rewinds a live branch.
- Backup publishes referenced CAS objects before pushing the Dolt `main` branch.
- An open engine never pulls or merges a live catalog.
- Future collaboration uses DoltHub-native catalog forks with the same
  `book_id`; fork/user/origin/PR APIs are deferred.

Core modules are flat and single-purpose:

- `schema.ts` — semantic/runtime schema and stage allowlists
- `store.ts` — SQL transactions, Dolt staging/commit, outbox recovery, push
- `books.ts` and `artifacts.ts` — singleton book and artifact lifecycle rules
- `cas.ts`, `files.ts`, `media.ts` — objects, mappings, materialization
- `domain.ts`, `metadata.ts`, `timeline.ts`, `communications.ts` — normalized
  semantic data
- `ids.ts` — UUIDv7 generation and caller-ID validation
- `job-queue.ts`, `runtime-services.ts`, `status.ts` — runtime coordination
- `history.ts` — Dolt projections, generic action graph, forward restores
- `storage.ts` — object publication and catalog backup

Public domain operations return `Result<T, EngineError>`. `IN_USE` errors
include stable `{kind, id}` references. Queue and lease primitives return
direct runtime values and use owner IDs/fences for CAS.

## Testing

Vitest tests use real embedded Dolt databases and temporary filesystems. The
required artifact lifecycle invariant is:

1. create `vid-cat`;
2. delete it;
3. create a new `vid-cat`;
4. verify the UUID, workspace, files, jobs, failures, leases, and history remain
   isolated.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
