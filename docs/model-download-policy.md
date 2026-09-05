# Local model download policy

Temporal CLIP/CLAP and compatibility image, audio, and text similarity loaders use local files unless `allowModelDownload` is explicitly `true`. A missing or unusable model returns `OFFLINE` when downloads are disabled. An application should offer an explicit preparation step, then use the populated cache for ordinary search and indexing.

The pinned Transformers.js 4.2.0 dependency drops `cache_dir`, `local_files_only`, and `revision` during metadata discovery in `pipeline`, `loadTokenizer`, and the model-registry file-list helpers. Without correction, even cached or local-only preparation can request metadata from `main`.

`scripts/patch-transformers.mjs` corrects option forwarding in the dependency's Node ESM entry before tests and bundling. It checks the dependency version and exact source fragments, is idempotent, and fails when those fragments change. The packaged runtime includes this correction; applications do not need Transformers.js installed separately. The third-party version manifest records `model-discovery-options-v1`. Review and remove the patch when a verified upstream version preserves these options throughout discovery.

`tests/model-download-policy.test.ts` uses a real HTTP server to count requests. It checks zero requests with absent or false permission across temporal and compatibility providers, and pinned requests with explicit permission. The real-model transfer test serves the existing pinned snapshots from a local fixture cache into an empty destination, then prepares new providers and repeats inference with downloads omitted. It requires an explicit test opt-in and never accesses the public Hub:

```bash
VIDEOBOOK_RUN_MODEL_POLICY_E2E=1 npm test -- tests/model-download-policy.e2e.test.ts
```

The source fixture cache defaults to `~/.cache/videobook/models`; override it with `VIDEOBOOK_MODEL_FIXTURE_CACHE`. It must already contain the pinned CLIP and CLAP snapshots used by the engine. This Transformers.js cache layout differs from the Hugging Face Hub CLI cache layout.
