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
- Patch SHA-256: `3d2f5d016755685d5a0f38e650813d71cc48695bbcca9c0df998c4ed9544e1ff`.
- Validated September 7, 2026 on macOS arm64, Node 24.10.0, Bun 1.3.14,
  compiled against the installed fork package's amalgamation (native
  `b3981dc9ed6b2e39c247b4d598b2691e19dd0b25`).
- Beads: `ve-xkv`.

It changes one native source file and adds three wrapper regression tests. It
changes no public API shape, native source, file format, or package version.

## Behavior

Native `dolt_merge()` already reports the outcome in its return value:

| Case | Native result |
| --- | --- |
| Fast-forward | the resulting commit hash, which is the incoming branch head |
| Three-way merge | the new merge commit hash, which is not the branch head |
| Up to date (branch is an ancestor of HEAD, or the same commit) | the text `Already up to date` |

The wrapper discarded that value. It now keeps it and reports
`fast_forward: 1` only when the result is a commit hash equal to the branch
head read back after the merge.

Both reads happen after the merge, so the outcome is never inferred from
unlocked pre-merge state. If a peer advances the incoming branch between the
merge and the branch-head read, the comparison fails and the result is a
conservative `0`; it is never a false positive.

## Validation

Compiled from source against the installed `@dolthub/doltlite`
`0.50.6-videobook.1` amalgamation, with the shipped darwin-arm64 prebuild moved
aside so the local build loaded:

- Wrapper suite: 132 tests pass across 6 files, including three new merge
  cases. Against the unpatched wrapper the fast-forward case fails
  (`expected 1, received 0`) and the other two pass, so the new tests pin the
  behavior in both directions.
- Direct probe: a fast-forward reports `fast_forward: 1` with HEAD equal to the
  branch head; a three-way merge reports `0` with HEAD on a new commit; an
  up-to-date merge reports `0` with HEAD unchanged.
- Engine advisory field: `mergeWithPolicy` from the built engine, running
  against a catalog opened by the patched build, returns
  `fastForward: true` for a fast-forward and `false` for a three-way merge,
  with merged rows intact in both.

## Adoption

Adopting this fix means republishing the fork package with the patched wrapper,
which is a release action and needs explicit authorization. Until then the
engine's `fastForward` result stays `false` for every merge. Nothing in the
engine branches on it — merge correctness comes from
`verifyConstraintHealth` and the post-merge ancestry checks — so the field is
advisory only.

The underlying fix belongs upstream in `dolthub/doltlite-node`; this patch is
recorded here so the engine keeps the provenance either way.
