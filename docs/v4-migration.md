# Copy-forward migration from schema v4

Keep the legacy book closed while migrating. `dryRunV4Migration(root)` and
`readV4BookIdentity(root)` inspect a disposable copy of its catalog. Migration
also reads a copy, leaving the original catalog and content bytes untouched.
The destination must be separate, including through symbolic-link aliases.

```ts
const preview = dryRunV4Migration(sourceRoot);
if (!preview.ok) throw new Error(preview.error.message);

const result = await migrateV4({
  sourceRoot,
  destinationRoot,
  dryRun: false,
  expectedSourceBookId: preview.value.sourceBookId,
  expectedSourceHead: preview.value.sourceHeadRevision,
  expectedMigrationKey: preview.value.migrationKey,
  signal: controller.signal,
  onProgress: ({ phase, completed, total }) => reportProgress(phase, completed, total),
});
```

The migration key covers the converter version, destination schema, source
head, and current semantic rows. It detects uncommitted changes even when IDs
and row counts are unchanged. The source is checked again before publication.
Dry runs report missing files, incorrect object sizes, invalid references,
unrepresentable notebook state, unsupported media, and required probing and
reindexing. Full object hashes and media probes are verified during migration
before a destination can be published. Timed conversion requires `ffprobe` on
PATH, or an explicit `ffprobePath`; it does not require model downloads.

Current artifact/file hashes, entities, notebook IDs, cell IDs, edge IDs, run
records, prompts, messages, waveforms, and compatible metadata are preserved.
Notebook canvas coordinates become deterministic row-major slots, ordered by
Y, X, and cell ID. A notebook exceeding the 64-by-8 grid is rejected. Legacy
scene cells become prompt cells with their entity references intact; asset
cells use their referenced artifact's current media type. Compatible notebook
fields and execution state are restored through the engine API. Original
coordinates, cell types, and all legacy notebook properties remain in the
machine-readable report.

Image slots retain the legacy three-second duration. Video slots use probed
stream duration and follow legacy `(ordinal, slot_id)` order on the first video
track. Audio clips retain their 30-fps start and duration on the first audio
track, including overlaps. They play at native speed, trimming the source when
the requested clip is shorter; a longer placement retains the legacy trailing
silence. Percentage volume becomes gain in dB, zero volume becomes mute, and
millisecond fades become frame counts. Fades exceeding the clip duration are
rejected instead of being silently shortened. Render orientation sets the
primary sequence dimensions. Every generated placement passes edit preview
and commit validation.

The report records source-head and current-table digests, conversion decisions,
new stream profiles, and the legacy source location. Legacy action/operation
history remains in that source; it is not injected into current Dolt history.
Legacy terminal job records remain part of the source audit, while current
runtime job IDs start fresh. Old similarity rows are discarded. The application
must queue indexing under its configured current manifests after switching.

Migration builds in a uniquely named sibling temporary directory and publishes
by rename only after its catalog, objects, notebook state, timeline, report,
and audit commit have succeeded. Cancellation or an ordinary failure removes
that temporary directory. Process termination can leave an unpublished
`<destination>.migrating-*` directory; retry safely creates a fresh candidate
and cannot duplicate destination rows. An identical completed migration returns
its verified receipt. Unrelated or incompatible nonempty destinations are never
overwritten. Migration itself never switches the application's book root.

Tests use the pinned schema from engine commit `580fc0e`, real JPEG/H.264/AAC/WAV
media, an empty book, a 1,001-media-artifact catalog with 1,536 notebook cells,
missing/corrupt objects, cancellation, process termination, source changes,
and repeated completed requests. Source catalog preservation is checked byte
for byte as well as through its head and semantic-state digest.
