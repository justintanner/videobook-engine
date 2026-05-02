import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";
import { withCleanWorktree } from "../src/git/stash.js";
import { getMetadataDb } from "../src/db/metadata-client.js";

/**
 * Regression: withCleanWorktree wraps work in `git stash push --include-untracked`
 * + `git stash pop`. Both replace the worktree's metadata.sqlite — a NEW inode
 * each time. If we hold onto a cached SQLite handle across that boundary,
 * SQLite eventually rejects writes with SQLITE_READONLY_DBMOVED, surfaced
 * as "attempt to write a readonly database". The fix in stash.ts evicts the
 * cached metadata.sqlite handle around the stash so subsequent opens bind to
 * the current inode.
 */
describe("withCleanWorktree + metadata.sqlite cache", () => {
  let sandbox: Sandbox;
  let projectSlug: string;
  let projectDir: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject("stash-cache-test");
    if (!result.ok) throw new Error("Failed to create project");
    projectSlug = result.value.slug;
    projectDir = path.join(sandbox.projectsDir, projectSlug);
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("writes succeed after withCleanWorktree replaces metadata.sqlite via stash push+pop", async () => {
    // 1. Seed + commit metadata.sqlite so HEAD has a valid file.
    const seed = await sandbox.fs.recordPrompt(
      { surface: "chat", prompt: "seed" },
      projectSlug,
    );
    expect(seed.ok).toBe(true);
    const commitHash = await sandbox.fs.commitOperation(
      "seed",
      undefined,
      undefined,
      projectSlug,
    );
    expect(commitHash).toBeTruthy();

    // 2. Warm the cache.
    const cachedHandle = getMetadataDb(projectDir);
    expect(cachedHandle.open).toBe(true);

    // 3. Make the worktree dirty so withCleanWorktree actually stashes
    //    (the fast path skips stash on a clean tree).
    const dirty = await sandbox.fs.recordPrompt(
      { surface: "chat", prompt: "dirty change" },
      projectSlug,
    );
    expect(dirty.ok).toBe(true);

    // 4. Run withCleanWorktree with a no-op work fn — exercises stash push+pop
    //    around an unrelated operation, which is the real-world pattern in
    //    asset/delete.ts and asset/rename.ts.
    await withCleanWorktree(projectDir, async () => {
      // Simulating the asset-directory work that withCleanWorktree wraps —
      // we don't write to metadata.sqlite here on purpose; that's the
      // pre-existing semantic where intra-stash writes get clobbered.
    });

    // 5. After stash pop, writes via the cached handle path must NOT throw
    //    "attempt to write a readonly database". Pre-fix this would fail.
    const after = await sandbox.fs.recordPrompt(
      { surface: "chat", prompt: "after withCleanWorktree" },
      projectSlug,
    );
    expect(after.ok).toBe(true);

    // 6. The "after" entry is durably persisted.
    const entries = await sandbox.fs.listPromptHistory(
      { surface: "chat", limit: 100 },
      projectSlug,
    );
    expect(entries.map((e) => e.prompt)).toContain("after withCleanWorktree");
  });

  it("repeated withCleanWorktree cycles don't accumulate stale handles", async () => {
    await sandbox.fs.recordPrompt(
      { surface: "chat", prompt: "seed" },
      projectSlug,
    );
    await sandbox.fs.commitOperation(
      "seed",
      undefined,
      undefined,
      projectSlug,
    );
    getMetadataDb(projectDir); // warm cache

    for (let i = 0; i < 3; i += 1) {
      // Re-dirty the tree before each cycle (stash pop restored it but a
      // fresh write makes the worktree dirty again for the next cycle).
      await sandbox.fs.recordPrompt(
        { surface: "chat", prompt: `dirty-${i}` },
        projectSlug,
      );
      await withCleanWorktree(projectDir, async () => {});
      const probe = await sandbox.fs.recordPrompt(
        { surface: "chat", prompt: `after-${i}` },
        projectSlug,
      );
      expect(probe.ok).toBe(true);
    }
  });
});
