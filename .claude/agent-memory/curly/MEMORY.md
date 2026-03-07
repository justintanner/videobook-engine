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

### Core Pattern: Result<T, FsError>
- All public methods return `Result<T, FsError>` -- discriminated union, no thrown exceptions for control flow
- Defined in `src/types.ts` (Result type, ok/err helpers, and error codes)
- Error codes: `NOT_FOUND`, `ALREADY_EXISTS`, `GIT_ERROR`, `INVALID_INPUT`, `IO_ERROR`, `LOCKED`

### Module Layout
- `src/project/` -- project lifecycle (create, list, get, switch)
- `src/asset/` -- asset lifecycle (create, delete, rename, list, manifest)
- `src/file/` -- file I/O (read, write, delete, rename, copy, resolve, metadata)
- `src/git/` -- git operations via `child_process.execFile`, exponential backoff retry
- `src/lock/` -- distributed locking via `O_CREAT | O_EXCL` atomic file creation
- `src/validation.ts` -- isSafePath, isSafeFilename, isWithinDir, invalidInput helper

### Key Patterns
- Zod for schema validation
- Every mutation produces an atomic git commit
- Mutations wrapped in `withGitLock` (in-process mutex per project dir)
- `src/index.ts` uses `withProject` helper to resolve project dir then delegate
- Slug generation: projects `{adjective}-{noun}-{number}`, assets `{prefix}-{slugified-name}[-{suffix}]`
- Constants centralized in `src/constants.ts`
- ESM package, Node.js >= 20

### Known Pattern Issue
- `withGitLock` blocks in file operations (write, delete, rename, copy) do not catch
  filesystem errors and convert to Result. An `fs.unlink`/`fs.rename`/`fs.copyFile` failure
  inside the lock throws past the Result boundary. This is a pre-existing pattern across
  all file mutation modules, not introduced by any single change.

## Common Patterns to Watch
- `let` where `const` suffices -- always flag
- Functions mixing computation with `execFile` calls -- extract pure computation
- `any` type annotations -- always flag, add specific types
- In-place array mutation where `.map()` would be clearer
