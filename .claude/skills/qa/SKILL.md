---
name: qa
description: Smoke-test the codebase by running typecheck, build, targeted tests, and code smell scans. Use when user types "/qa", "run qa", "check my changes", or "run tests".
allowed-tools: Bash, Grep, Read, Glob
---

# qa

## Context

- Recently changed files: !`git diff --name-only HEAD~1 2>/dev/null`
- Staged files: !`git diff --staged --name-only`
- Unstaged changes: !`git diff --name-only`

## Instructions

Run all steps below and report a summary. Do not fix issues — only report them. Use a 5-minute timeout for the entire run.

### Step 1: Identify changed files

Collect all changed `.ts` files from the context above (recently changed, staged, and unstaged) into a single deduplicated list. These drive Tier 2 selection and code smell checks.

### Step 2: Tier 1 — Import chain & basic smoke tests

Run these commands unconditionally:

```bash
npm run typecheck
npm run build
```

**If `npm run typecheck` fails, the type system is broken. Report immediately and stop — do not continue to later steps.**

Record exit code and whether output looks reasonable (no errors).

### Step 3: Tier 2 — Targeted tests

Match changed files against these patterns and run the corresponding test commands:

| Changed file pattern | Test command |
|---|---|
| `src/project/*` | `npx vitest run tests/project.test.ts` |
| `src/asset/*` | `npx vitest run tests/asset.test.ts tests/status.test.ts` |
| `src/git/*` | `npx vitest run tests/git.test.ts` |
| `src/lock/*` | `npx vitest run tests/lock.test.ts` |
| `src/file/*` | `npx vitest run tests/file.test.ts` |

If no specific file pattern matches but any `src/` files changed, run `npx vitest run tests/green-path.test.ts` as a general check.

### Step 4: Code smell scan

Scan changed `.ts` files (exclude `tests/` directory and `.claude/` directory) using Grep for:

- `console.log` — debug logging left in source
- `debugger` — debugger statements
- `: any` — untyped annotations
- `// @ts-ignore` or `// @ts-expect-error` — type suppressions
- `as any` — unsafe type casts

Record each finding with file path and line number.

### Step 5: Run full test suite

Run `npx vitest run` and capture the output. Record pass/fail and any failure details.

### Step 6: Report summary

Output a summary table:

```
## QA Results

| Check          | Status | Details |
|----------------|--------|---------|
| Typecheck      | ...    | ...     |
| Build          | ...    | ...     |
| Targeted tests | ...    | ...     |
| Code smells    | ...    | ...     |
| Full tests     | ...    | ...     |
```

Below the table, list every command that was run and its exit code. Then list any issues found with file paths and line numbers.

If all checks pass, end with "All QA checks passed."
