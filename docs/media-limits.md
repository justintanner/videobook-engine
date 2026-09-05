# Local media decoding limits

Temporal CLIP/CLAP and compatibility similarity use shared bounded decoding
helpers. FFmpeg and FFprobe run with argument arrays and no shell. Their
default execution deadline is 120 seconds. A caller can provide a positive,
finite `timeoutMs` and an `AbortSignal` through `MediaOperationOptions`.
Cancellation, deadline expiry or excessive output kills the process and waits
for its close before rejecting, allowing callers to clean temporary workspaces.

Standard error is capped at 64 KiB. Probe output is capped at 64 KiB; PCM
output is capped at the requested sample count times four bytes. Temporal
CLAP decodes at most ten seconds of 48 kHz mono audio. Other process output
has an 8 MiB default cap. Decoder failures report typed errors and exit
information without copying raw stderr, input paths or cancellation reasons
into the error message. `TIMEOUT`, `CANCELLED`, `RESOURCE_EXHAUSTED`,
`FEATURE_UNAVAILABLE` and `INVALID_INPUT` distinguish failure categories.

FFmpeg input protocols are restricted to `file,pipe`. Compatibility video
extraction uses a disposable directory, at most 120 PNG frames and a fixed
224 by 224 output size, with cleanup in `finally`. These controls do not
constitute a filesystem sandbox for a decoder.

Image inputs must be regular local files no larger than 64 MiB and 40 million
pixels. Sharp reads only the first image, applies a processing timeout and
converts to RGB using the existing orientation and colour normalization.
Accepted images keep the same preprocessing; oversized images fail before
an unbounded RGB allocation. The pixel cap also limits expansion of compact
inputs such as large SVG canvases. No global Sharp settings are changed.

Compatibility preparation/index/query methods forward media options to their
providers. Indexing checks cancellation before publishing runtime coverage.
Temporal providers accept media options directly:

```ts
await clip.embedImage(path, { signal });
await clap.embedAudio(path, 0, 10, { signal, timeoutMs: 30_000 });
await engine.similarity.index(artifactId, { signal });
```

`tests/media-limits.test.ts` uses actual child processes for stalled/noisy
output, literal arguments, abort-before-spawn, running cancellation and safe
errors. Real Sharp fixtures cover malformed, oversized and high-expansion
images. A scoped engine fixture verifies failed decoding leaves source data
and prior coverage intact and allows retry. The opt-in cached CLIP/CLAP and
compatibility E2E tests verify real JPEG/MP4/WAV decoding, CLAP timeout and
cancellation, malformed audio and successful retry.

This completes the bounded subprocess/image portion of `ve-ovz.13`. Model
loading and inference still run in the calling process. Cancellation is
checked around those calls, but cannot yet interrupt native inference or
contain a fatal native/model allocation failure. Sharp cancellation is also
checked around the decode; its processing deadline is rounded up to seconds.
Process isolation, complete job-failure/retry verification and consumer signal
forwarding remain required before this release-hardening issue can close.
