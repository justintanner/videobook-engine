# Immutable model revision selection

Built-in CLIP, CLAP and MiniLM models continue to use their existing pinned commits. No new model setting is needed for their default configuration. The compatibility image/video vector cache requires a one-time reindex, as described below. Temporal, audio and text default embedding identities are unchanged.

For a custom remote model used by the compatibility similarity API, supply `modelRevision` alongside `modelId`. It must be a full 40-character hexadecimal commit SHA from that model repository. Branch names, tags, abbreviated hashes and omitted custom revisions fail with `INVALID_INPUT` before any model request. Uppercase hashes are normalized to lowercase.

```typescript
const engine = createEngine({
  rootDir,
  similarity: {
    modelCacheDir,
    modelId: "your-org/compatible-clip",
    modelRevision: clipCommitSha,
    allowModelDownload: true,
    audio: {
      modelId: "your-org/compatible-clap",
      modelRevision: clapCommitSha,
    },
    text: {
      modelId: "your-org/compatible-minilm",
      modelRevision: textCommitSha,
    },
  },
});
const prepared = await engine.similarity.prepare();
```

Each `*CommitSha` variable above is the actual full commit ID selected by the application. The engine does not resolve a moving alias implicitly. Supplying another commit for a built-in repository is also supported and creates a distinct custom embedding identity. Audio and text select their own repositories and revisions; they do not inherit the visual model selection. The existing cache-directory and download-permission inheritance rules are unchanged.

Custom models must remain compatible with the corresponding pipeline: 512-dimensional CLIP image/video embeddings, 512-dimensional CLAP audio embeddings or 384-dimensional MiniLM text embeddings, with the supported quantization and preprocessing. Selecting a commit does not make an incompatible model architecture compatible.

## Coherent loading and index identity

The selected repository and commit are copied into the model worker configuration and worker-session key. Every model-file request must agree with them, including tokenizer/config files and external ONNX weights. A request for another repository, another commit or an omitted/moving revision fails with `MODEL_UNAVAILABLE`. Remote selections do not fall back to unversioned files under Transformers' `localModelPath`; use an explicit directory model ID for trusted local files.

Custom embedding-space identities include the provider kind, exact repository, full revision and preprocessing version through a SHA-256 digest. Repository names that previously collided after punctuation normalization now remain distinct. A different revision cannot reuse vectors from an existing space, even while the old model worker is warm. Changing a caller's configuration object after Engine construction does not alter the selected model.

Existing custom-model vector identities intentionally change. Reindex custom-model artifacts after supplying the commit. The API shape remains source-compatible on version 5.3.1, but old custom remote configurations without a commit now fail closed rather than loading `main`.

Older compatibility image/video vectors are ambiguous: custom image models previously used the same embedding-space string as the built-in CLIP model, without recording which model produced a row. The compatibility visual space now uses `compat-visual-v2`, including for the default model. This requires a one-time reindex of compatibility image/video artifacts and prevents old custom vectors from silently being treated as built-in vectors. Until reindexed, status returns `not_indexed` and similarity queries return `NOT_READY`. Source media and the old derived rows remain intact. The media library's temporal index and the default compatibility audio/text spaces retain their identities; model files do not need to be downloaded again.

Model downloads still require explicit permission. After online preparation, the selected revision's verified cached files and integrity receipts support offline preparation, indexing and queries. Changing to a revision that is not cached returns `OFFLINE`; it does not substitute another revision. [Model integrity verification](model-integrity.md) describes digest verification and its trust boundary for custom repositories.

## Local directories

Absolute paths and explicit relative paths beginning with `.` remain supported as trusted local model directories, without `modelRevision` or network access. Relative paths are resolved when the provider is configured. Equivalent resolved paths share an identity; different directory paths have distinct identities. `modelRevision` applies only to remote repositories and is rejected for directory selections.

Keep each local model version in a separate immutable directory. Local directories do not carry a verified upstream commit, and their contents are not authenticated as a remote snapshot. Replacing files in place requires application-owned reindexing; the engine does not claim that a path alone makes local bytes immutable.

Injected embedding providers manage their own model identity and revisions. These options apply to built-in loader implementations, not to arbitrary injected code. Injected providers remain subject to the [network declaration and application consent contract](search-provider-consent.md).

## Verification

`tests/model-revision.test.ts` uses actual Engine APIs and an HTTP receiver to cover rejected revisions with zero requests, all three modalities' pinned requests, separate identities, configuration snapshots, local-directory selection, and cross-repository/revision file rejection. `tests/model-revision.e2e.test.ts`, enabled by `VIDEOBOOK_RUN_CUSTOM_MODEL_E2E=1`, serves real cached CLIP/CLAP/MiniLM files under custom repository IDs and verifies coherent revision requests, indexing, offline reopen, revision isolation, retained source bytes and explicit local-directory inference. It requires the three fixture models to have been prepared separately; it does not download them from an external service.
