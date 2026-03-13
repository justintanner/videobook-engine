# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

clipfirst-fs is a TypeScript/Node.js filesystem abstraction library for managing video/image asset projects with integrated Git version control and distributed locking. It is an ESM package targeting Node.js >= 20.

## Commands

```bash
npm run build        # tsc — compile TypeScript to dist/
npm run typecheck    # tsc --noEmit — type-check only
npm test             # vitest run — run tests once
npm run test:watch   # vitest — run tests in watch mode
npx vitest run tests/asset.test.ts   # run a single test file
```

## Architecture

**Entry point:** `src/index.ts` exports `createFs(config: FsConfig)` factory that returns a `ClipfirstFs` interface. Config takes `{projectsDir, gitPath?}`.

**Module layout** — each module is a directory with single-responsibility files:

- `src/project/` — project lifecycle (create, list, get, switch). Projects are directories in projectsDir, each a git repo.
- `src/asset/` — asset lifecycle (create, delete, rename, list, manifest). Assets are prefixed directories (`vid-`, `img-`, `aud-`, `script-`) inside a project.
- `src/file/` — file I/O (read, write, metadata). Writes trigger atomic git commits.
- `src/git/` — git operations via `child_process.execFile`. Commits use scoped staging, structured messages, and exponential backoff retry for index.lock contention.
- `src/lock/` — distributed locking via `O_CREAT | O_EXCL` atomic file creation. Lock files are gitignored.
- `src/constants.ts` — lock file names and filename constants.
- `src/types.ts` — shared type definitions, `Result<T, E>` discriminated union, and `FsError` error codes (`NOT_FOUND`, `ALREADY_EXISTS`, `GIT_ERROR`, `INVALID_INPUT`, `IO_ERROR`, `LOCKED`).

**Key patterns:**
- All public methods return `Result<T, FsError>` instead of throwing.
- Every mutation (create/delete/rename asset, write file) produces an atomic git commit.
- Slug generation: projects use `{adjective}-{noun}-{number}`, assets use `{prefix}-{slugified-name}[-{suffix}]` with collision detection.
- Zod is used for schema validation.

## Testing

Tests use Vitest with real filesystem I/O (zero mocks). Each test creates an isolated sandbox via `tests/helpers/sandbox.ts` which sets up a temp directory with git configured. Timeouts: 30s for tests, 15s for hooks.
