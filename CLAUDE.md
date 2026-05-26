# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

vc-engine is a TypeScript/Node.js filesystem abstraction library for managing video, image, audio, script, and character asset projects. Each project is a git repo with a `.clipfirst/` sidecar that holds two SQLite databases: `state.sqlite` for ephemeral coordination (locks, job queue, recovery journal, process locks) and `metadata.sqlite` for content metadata (timeline, characters, asset/project metadata, audio waveforms). It is an ESM package targeting Node.js >= 20.

## Commands

```bash
npm run build        # tsc — compile TypeScript to dist/
npm run typecheck    # tsc --noEmit — type-check only
npm test             # vitest run — run tests once
npm run test:watch   # vitest — run tests in watch mode
npx vitest run tests/asset.test.ts   # run a single test file
npm run bench        # vitest bench --config vitest.config.bench.ts
```

## Architecture

**Entry point:** `src/index.ts` exports `createFs(config: FsConfig)` factory that returns a `ClipfirstFs` interface. Config takes `{projectsDir, gitPath?}`. The factory binds `projectsDir` and exposes a project-scoped surface — every method other than the project lifecycle takes a `projectSlug` argument.

**Module layout** — each module is a directory with single-responsibility files:

- `src/project/` — project lifecycle (create, list, get, switch, rename). Projects are directories under `projectsDir`, each a git repo. Slugs are `{adjective}-{noun}-{number}`.
- `src/asset/` — asset lifecycle (create, delete, rename, list, manifest, list-subdir). Assets are prefixed directories at the project root. Valid prefixes: `vid-`, `img-`, `aud-`, `script-`, `char-`. The id `final` is a project-level singleton. Slugs are `{prefix}-{slugified-name}[-{counter}]` with collision detection against both live directories and historical git slugs.
- `src/file/` — file I/O (read, write, delete, rename, copy, metadata, audio-waveform). Mutations route through `db/run-operation.ts` so they share the recovery journal and atomic-commit machinery.
- `src/git/` — git operations via `child_process.execFile` (`gitExecSafe`). Commits use scoped staging, structured `op-id`-tagged messages, and exponential backoff for `index.lock` contention. `withGitLock(projectDir, fn)` is the per-project mutex (in-process chain + `proper-lockfile` on `.clipfirst/.project.lock`).
- `src/lock/` — SQLite-backed asset/project locking. One row per `(projectDir, assetKey)` in the `locks` table; `assetKey` is the first path segment under the project, or `__PROJECT__` for project-root locks. Stale locks (expired timeout or dead pid) are reaped on next acquire.
- `src/action/` — append-only action log built on git commits with structured payloads.
- `src/queue/` — persistent job queue in `state.sqlite` (`pending_jobs`). Supports dedupe keys, external task ids, leased dequeue with heartbeats, and a `QueueRunner` coordinated across processes. `fs.queue` is the project-scoped wrapper; `queueApi` is the raw `Database`-handle API.
- `src/db/` — SQLite layer. `client.ts` opens `state.sqlite` (cached per `projectDir`); `metadata-client.ts` opens `metadata.sqlite`. `migrate.ts` runs versioned migrations from `migrations/` and verifies checksums. `run-operation.ts` is the central choreographer: it opens a `recovery_journal` row, runs SQLite work in a transaction, rebuilds canonical JSON exports under `.clipfirst/export/`, calls `commitOperation`, then finalizes the journal. `recover.ts` replays incomplete journal rows on startup. `version-guard.ts` rejects projects written by a newer schema.
- `src/log.ts` — generic per-project JSONL append-only logs under `logs/{name}.jsonl` (gitignored).
- `src/constants.ts` — `DEFAULT_PROJECT_FILE`, `LOCK_FILE`, `CREATED_AT_FILE`.
- `src/validation.ts` — path/filename/asset-id/prefix validation and the `invalidInput` helper.
- `src/types.ts` — shared types, `Result<T, E>` discriminated union, `FsError` error codes (`NOT_FOUND`, `ALREADY_EXISTS`, `GIT_ERROR`, `INVALID_INPUT`, `IO_ERROR`, `LOCKED`).

**Key patterns:**
- All public mutating methods return `Result<T, FsError>` instead of throwing.
- Every mutation produces an atomic git commit. Metadata mutations stage `metadata.sqlite`, the affected canonical JSON exports under `.clipfirst/export/`, and any human-readable sidecar (`.{key}.json` next to the asset) in a single commit whose body includes `op-id: <uuid>`.
- Recovery: `recoverIncompleteOperations(slug)` walks the recovery journal at startup and re-derives missing exports/sidecars + a `recover` commit so SQLite, exports, and git always agree.
- `.clipfirst/state.sqlite` and its WAL/SHM/journal sidecars are gitignored automatically by `ensureGitignorePatterns`. `.clipfirst/metadata.sqlite` is checked in.
- Zod is used for schema validation. `better-sqlite3` is the SQLite driver.

## Testing

Tests use Vitest with real filesystem I/O (zero mocks). Each test creates an isolated sandbox via `tests/helpers/sandbox.ts` which sets up a temp directory with git configured. Timeouts: 30s for tests, 15s for hooks.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
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

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
