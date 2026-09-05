# Local model process isolation

Built-in temporal CLIP/CLAP and compatibility image/video/audio/text providers
load models and perform inference in child processes. Workers receive only
the selected text or absolute media path and a projected model configuration.
They do not receive an Engine, a catalog handle, book metadata, job payloads
or general provider credentials, and never open a book database.

Each calling Node process shares a pool of at most two model workers, keyed
by model/cache/download configuration. Calls to one worker are serialized;
the pool accepts at most 64 waiting calls. Matching workers reuse loaded models.
Idle workers are evicted when another configuration needs capacity or after
30 seconds. They do not keep the host process alive. Host exit kills cached
workers and removes their owned scratch directories.

The worker environment includes basic executable/home/temp/locale settings.
Hugging Face token variables are forwarded only when downloads are explicitly
enabled. Provider keys, arbitrary environment variables and `NODE_OPTIONS`
are excluded. The existing Transformers remote-host/local-model settings are
projected into the worker so pinned offline discovery and configured mirrors
retain their behavior. Arbitrary JavaScript fetch hooks are not serialized.

Preparation defaults to a 15-minute deadline, covering explicit first-time
downloads. Inference defaults to two minutes, including waiting for a worker.
`MediaOperationOptions.timeoutMs` overrides the deadline; `signal` cancels a
queued call without affecting active work, or kills the active worker and its
decoder process group. A request resolves or rejects after required worker
cleanup. The next call after a failure starts a fresh process. Applications
must forward their job signal through provider overrides and calls.

Workers have a 512 MiB V8 heap limit. Model weights and native allocations are
outside that heap limit; it is not a total-RSS operating-system sandbox.
Input text is capped at 1 MiB, media paths at 4 KiB, IPC messages at 2 MiB and
diagnostic output at 64 KiB. Returned vector dimensions, finite values, text
offsets and video frame counts are validated before use. Media decoding also
uses the limits in `docs/media-limits.md`.

A fatal worker allocation failure or abrupt termination returns a typed
`RESOURCE_EXHAUSTED` or `MODEL_UNAVAILABLE` error to the host. Ordinary allocator
errors are classified as resource exhaustion even when a model loader wrapped
them in an offline-readiness error. Unrecognized exceptions do not forward
model inputs or raw native diagnostics. No semantic transaction spans an
inference call, and cancellation is checked before index coverage publication.

`tests/model-worker-pool.test.ts` uses actual child processes to verify reuse,
capacity, queue cancellation, blocked execution, decoder descendants, invalid
responses, environment filtering, idle cleanup and host-exit cleanup. A worker
with a deliberately small heap is exhausted while a real engine remains open;
the test then writes, reopens the book and successfully starts another worker.
An additional durable QueueRunner test records the allocation failure as a
failed job with `RESOURCE_EXHAUSTED`, then completes another job successfully.
QueueRunner preserves EngineFault codes instead of replacing them with the
exception class name.
This is a real V8 allocation failure, not a simulation of physical disk failure
or whole-machine memory pressure. `tests/local-models.e2e.test.ts`, compatibility
media E2E and the model-transfer fixture exercise actual models through the
same transport. The package smoke also starts the installed JavaScript worker,
checks missing-cache offline failure, and can run cached CLIP/CLAP inference.

The worker entry is compiled into the package and declared as an executable
entry in the dead-code configuration. Source tests use the installed `tsx`
loader; installed packages use JavaScript and need no `tsx` dependency.
