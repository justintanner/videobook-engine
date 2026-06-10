# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

videocity-engine is a TypeScript/Node.js filesystem abstraction library for managing video, image, audio, script, and character asset projects. Each project is a git repo with a `.videocity/` sidecar that holds two SQLite databases: `state.sqlite` for ephemeral coordination (locks, job queue, recovery journal, process locks) and `metadata.sqlite` for content metadata (timeline, characters, asset/project metadata, audio waveforms). It is an ESM package targeting Node.js >= 20.

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

**Entry point:** `src/index.ts` exports `createFs(config: FsConfig)` factory that returns a `VideocityFs` interface. Config takes `{projectsDir, gitPath?}`. The factory binds `projectsDir` and exposes a project-scoped surface — every method other than the project lifecycle takes a `projectSlug` argument.

**Module layout** — each module is a directory with single-responsibility files:

- `src/project/` — project lifecycle (create, list, get, switch, rename). Projects are directories under `projectsDir`, each a git repo. Slugs are `{adjective}-{noun}-{number}`.
- `src/asset/` — asset lifecycle (create, delete, rename, list, manifest, list-subdir). Assets are prefixed directories at the project root. Valid prefixes: `vid-`, `img-`, `aud-`, `script-`, `char-`. The id `final` is a project-level singleton. Slugs are `{prefix}-{slugified-name}[-{counter}]` with collision detection against both live directories and historical git slugs.
- `src/file/` — file I/O (read, write, delete, rename, copy, metadata, audio-waveform). Mutations route through `db/run-operation.ts` so they share the recovery journal and atomic-commit machinery.
- `src/git/` — git operations via `child_process.execFile` (`gitExecSafe`). Commits use scoped staging, structured `op-id`-tagged messages, and exponential backoff for `index.lock` contention. `withGitLock(projectDir, fn)` is the per-project mutex (in-process chain + `proper-lockfile` on `.videocity/.project.lock`).
- `src/lock/` — SQLite-backed asset/project locking. One row per `(projectDir, assetKey)` in the `locks` table; `assetKey` is the first path segment under the project, or `__PROJECT__` for project-root locks. Stale locks (expired timeout or dead pid) are reaped on next acquire.
- `src/action/` — append-only action log built on git commits with structured payloads.
- `src/queue/` — persistent job queue in `state.sqlite` (`pending_jobs`). Supports dedupe keys, external task ids, leased dequeue with heartbeats, and a `QueueRunner` coordinated across processes. `fs.queue` is the project-scoped wrapper; `queueApi` is the raw `Database`-handle API.
- `src/db/` — SQLite layer. `client.ts` opens `state.sqlite` (cached per `projectDir`); `metadata-client.ts` opens `metadata.sqlite`. `migrate.ts` runs versioned migrations from `migrations/` and verifies checksums. `run-operation.ts` is the central choreographer: it opens a `recovery_journal` row, runs SQLite work in a transaction, rebuilds canonical JSON exports under `.videocity/export/`, calls `commitOperation`, then finalizes the journal. `recover.ts` replays incomplete journal rows on startup. `version-guard.ts` rejects projects written by a newer schema.
- `src/log.ts` — generic per-project JSONL append-only logs under `logs/{name}.jsonl` (gitignored).
- `src/constants.ts` — `DEFAULT_PROJECT_FILE`, `LOCK_FILE`, `CREATED_AT_FILE`.
- `src/validation.ts` — path/filename/asset-id/prefix validation and the `invalidInput` helper.
- `src/types.ts` — shared types, `Result<T, E>` discriminated union, `FsError` error codes (`NOT_FOUND`, `ALREADY_EXISTS`, `GIT_ERROR`, `INVALID_INPUT`, `IO_ERROR`, `LOCKED`).

**Key patterns:**
- All public mutating methods return `Result<T, FsError>` instead of throwing.
- Every mutation produces an atomic git commit. Metadata mutations stage `metadata.sqlite`, the affected canonical JSON exports under `.videocity/export/`, and any human-readable sidecar (`.{key}.json` next to the asset) in a single commit whose body includes `op-id: <uuid>`.
- Recovery: `recoverIncompleteOperations(slug)` walks the recovery journal at startup and re-derives missing exports/sidecars + a `recover` commit so SQLite, exports, and git always agree.
- `.videocity/state.sqlite` and its WAL/SHM/journal sidecars are gitignored automatically by `ensureGitignorePatterns`. `.videocity/metadata.sqlite` is checked in.
- Zod is used for schema validation. `better-sqlite3` is the SQLite driver.

## Testing

Tests use Vitest with real filesystem I/O (zero mocks). Each test creates an isolated sandbox via `tests/helpers/sandbox.ts` which sets up a temp directory with git configured. Timeouts: 30s for tests, 15s for hooks.


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
