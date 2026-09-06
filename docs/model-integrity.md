# Model file integrity

Built-in model workers verify model files before the loader receives either
bytes or an ONNX file path. This covers configuration, tokenizers, processors,
model graphs and external ONNX weight shards. A verification error returns
`MODEL_UNAVAILABLE`; no corrupted download is published to the model cache.
Integrity failures remain fatal even if an upstream optional-file loader catches
the initial exception. They are not reported as missing-model readiness.

`src/model-checksums.json` records the complete file inventories of the three
built-in pinned CLIP, CLAP and MiniLM snapshots. The hashes and sizes come from
the Hugging Face repository tree at each exact revision. Git files use Git blob
SHA-1, including the `blob <byte-count>\0` prefix; LFS files use content SHA-256.
The distinction follows the [Hub file metadata contract](https://huggingface.co/docs/huggingface_hub/en/package_reference/file_download).
Existing built-in caches can therefore be verified offline without adding a
network dependency or changing the Transformers cache directory layout.

The checksums are for these revisions:

- [CLIP d15189d7](https://huggingface.co/Xenova/clip-vit-base-patch32/tree/d15189d7028b43f1d3e65039190477f6af591c2a)
- [CLAP c28f2883](https://huggingface.co/Xenova/clap-htsat-unfused/tree/c28f2883575e590e04d3146ff0713c2448d691ba)
- [MiniLM aff7a1dc](https://huggingface.co/onnx-community/all-MiniLM-L6-v2-ONNX/tree/aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f)

Maintainers can regenerate the inventories with
`node scripts/update-model-checksums.mjs`, using the installed `hf` CLI. Review
the generated diff and keep model revision constants and inventories aligned.
Builds and ordinary model use never run this networked maintenance command.

For other remote models, the resolver checks a supported strong ETag or
`X-Linked-ETag` on the original model response. Redirects retain that digest;
CDN ETags and Xet chunk identifiers are not substituted for the original file
hash. Authorization tokens are sent only to `https://huggingface.co`, and
redirects cannot downgrade HTTPS. If upstream supplies no supported checksum,
the cache receipt records a transport SHA-256 for subsequent corruption
detection, explicitly distinct from upstream verification.

Custom remote-model cache files without integrity metadata require an explicit
online preparation before offline use. Explicit local model directories remain
application-trusted inputs with no implied upstream authenticity. Local cache
receipts detect corruption; they do not defend against someone deliberately
rewriting both a custom model and its receipt with local filesystem access.

Each worker reads a cached file into its own verified snapshot before use. The
loader never receives the original mutable cache path. Relative names and
directory layout are retained so ONNX external data stays adjacent to its graph.
Loaded models and verified snapshots are reused within that worker. A new worker
verifies cached bytes again. Changing a cache file cannot change an already
verified worker snapshot.

Downloads stream into the owned worker workspace, are verified, then are copied
to an owned staging directory under the configured cache and atomically renamed.
Receipts are published separately; interrupted publication can require another
preparation for a custom model but cannot authorize mismatching bytes. Parent
cancellation, eviction and exit remove owned worker and cache-staging files.
Files are capped at 2 GiB and in-memory metadata returns at 16 MiB. The existing
worker deadlines, process limits and cancellation cover hashing and transfer.

An invalid existing cache entry is left intact for diagnosis. Remove or restore
the affected entry, then explicitly prepare the model to retry. Preparing does
not silently delete a corrupt file. The Hugging Face CLI's `hf cache verify`
supports `--local-dir` pointing at one Transformers model/revision directory
when an administrator needs a file-level audit.

Tests cover Git and LFS digests, redirects, unsupported metadata, corrupt
downloads and receipts, offline corruption, concurrent loads, snapshot isolation,
path/size limits, and killed cache-staging cleanup. Real-model tests transfer and
reuse CLIP/CLAP, reject modified JSON/tokenizer/ONNX bytes, and exercise MiniLM
external weights, offline reopen and a corrupt weight shard. The installed
package smoke always checks corrupted pinned configuration rejection and can
also run real cached model inference.

Custom remote compatibility models also require an explicit immutable commit. See [model revision selection](model-revisions.md) for coherent file loading, embedding-space isolation and migration from moving aliases. Explicit local-directory models remain trusted local inputs.
