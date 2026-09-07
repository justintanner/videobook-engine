# True merge outcome in the Node wrapper

The [source patch](merge-fast-forward.patch) fixes the Node wrapper's
`doltMerge()` result, which hard-coded `fast_forward` to `0` for every merge —
including a merge that advanced HEAD to exactly the incoming branch head. The
engine mirrors that field in `mergeWithPolicy`, so its advisory `fastForward`
was always `false`.

This is a wrapper bug, independent of the native
[ignored-runtime merge fix](../doltlite/README.md). The temporary fork package
`0.50.6-videobook.1` deliberately ships the published wrapper source unchanged,
so it carries this bug too.

## Provenance

- Source: [dolthub/doltlite-node](https://github.com/dolthub/doltlite-node).
- Base: [`4bed4889be31c683f81291e2f661d07e50b7a3fe`](https://github.com/dolthub/doltlite-node/commit/4bed4889be31c683f81291e2f661d07e50b7a3fe),
  the wrapper revision the fork package ships (`wrapperCommit` in
  `fork-provenance.json`).
- Patch SHA-256: `ad3964c77fd49e153616cec9fd7271060f490e583ee46feec69996483df67964`.
- Validated September 7, 2026 on macOS arm64, Node 24.10.0, Bun 1.3.14,
  compiled against the installed fork package's amalgamation (native
  `b3981dc9ed6b2e39c247b4d598b2691e19dd0b25`).
- Beads: `ve-xkv`.

It changes one wrapper source file and adds six wrapper regression tests. It
changes no public API shape, native source, file format, or package version.

## Behavior

Native `dolt_merge()` already reports the outcome in its return value:

| Case | Native result |
| --- | --- |
| Fast-forward | the resulting commit hash, which is the incoming branch head |
| Three-way merge | the new merge commit hash, which is not the branch head |
| Up to date (branch is an ancestor of HEAD, or the same commit) | the text `Already up to date` |

The wrapper discarded that value. It now resolves the incoming branch once
and passes that immutable commit hash to native `dolt_merge`. It reports
`fast_forward: 1` only when the result equals that actual merge input.
A peer moving or deleting the branch cannot change this comparison. Merge
commit messages retain the caller's branch label; native merge-source
metadata refers to the selected commit hash.

Review found that the earlier patch's post-merge branch read was still
racy. If a peer fast-forwards the incoming branch to a just-created
three-way merge commit, comparing that branch with the merge result
incorrectly reports a fast-forward. Re-reading a deleted branch can also
turn a completed merge into an error. Pinning the native input removes
that mutable lookup.

## Validation

Compiled from source against the installed `@dolthub/doltlite`
`0.50.6-videobook.1` amalgamation, with the shipped darwin-arm64 prebuild moved
aside so the local build loaded:

- Wrapper suite: 135 tests pass across 6 files, including six new merge
  cases. Against the unpatched wrapper the fast-forward case fails
  (`expected 1, received 0`) and the other two pass, so the new tests pin the
  behavior in both directions. Additional cases cover a fast-forward whose
  incoming commit is itself a merge, a quoted branch label in the commit
  message, and rejection of a missing source without changing HEAD.
- Direct probe: a fast-forward reports `fast_forward: 1` with HEAD equal to the
  branch head; a three-way merge reports `0` with HEAD on a new commit; an
  up-to-date merge reports `0` with HEAD unchanged.
- Engine advisory field: `mergeWithPolicy` from the built engine, running
  against a catalog opened by the patched build, returns
  `fastForward: true` for a fast-forward and `false` for a three-way merge,
  with merged rows intact in both.

- Full engine catalog probe against the rebuilt wrapper passes, including
  conflicts, ignored runtime state, indexes, integrity, and reopen through
  the installed binding.
- A deterministic interleaving probe injects
  `dolt_branch('-f', source, mergeResult)` immediately after the native merge
  returns, before classification. It uses real native branches and rows:
  the earlier patch reports `1` for the three-way merge, while this patch
  reports `0`. The probe verifies that the source really moved to the merge
  commit and both sides' rows survived. Test instrumentation was removed
  before the final wrapper build and full suite.

## Adoption

This is a recorded source patch; the installed fork has not been rebuilt.
The next native package must carry this corrected patch and the recorded
hard-reset fix, with the existing platform and installation checks. Until then the
engine's `fastForward` result stays `false` for every merge. Nothing in the
engine branches on it — merge correctness comes from
`verifyConstraintHealth` and the post-merge ancestry checks — so the field is
advisory only.

The underlying fix belongs upstream in `dolthub/doltlite-node`; this patch is
recorded here so the engine keeps the provenance either way.
