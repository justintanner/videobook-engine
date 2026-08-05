export { SCHEMA_VERSION } from "./catalog-metadata.js";
import { SCHEMA_VERSION } from "./catalog-metadata.js";

export const NOTEBOOK_CELL_TYPES = [
  "audio",
  "image",
  "video",
  "extract_audio",
  "extract_frame",
  "split_video",
  "prompt",
  "character",
  "analyze",
  "analysis",
  "generate_video",
  "generate_image",
  "generate_audio",
  "concat",
  "splice",
] as const;

export type NotebookCellType = (typeof NOTEBOOK_CELL_TYPES)[number];

// The staging allowlist is also the restore table list: history.restore
// reloads every table below from its dolt_at_* projection, deleting in
// reverse order and inserting in forward order. Keep the list ordered
// parent-before-child so the mechanical reload satisfies foreign keys.
export const SEMANTIC_TABLES = [
  "engine_schema",
  "book",
  "artifacts",
  "objects",
  "artifact_files",
  "artifact_streams",
  "book_metadata",
  "artifact_metadata",
  "entities",
  "notebooks",
  "notebook_fields",
  "cells",
  "notebook_cell_executions",
  "notebook_generation_plans",
  "notebook_run_plans",
  "edges",
  "runs",
  "cell_references",
  "pinned_search_results",
  "transcripts",
  "transcript_segments",
  "transcript_words",
  "sequences",
  "sequence_tracks",
  "sequence_clips",
  "clip_links",
  "clip_transforms",
  "transitions",
  "caption_cues",
  "audio_waveforms",
  "prompt_entries",
  "messages",
] as const;

export type SemanticTable = (typeof SEMANTIC_TABLES)[number];

export const RUNTIME_TABLES = [
  "runtime_meta",
  "runtime_jobs",
  "job_runs",
  "runtime_resource_leases",
  "runtime_object_publications",
  "runtime_workspace_entries",
  "runtime_artifact_views",
  "runtime_pending_tasks",
  "runtime_generation_errors",
  "runtime_settings",
  "runtime_logs",
  "runtime_commit_outbox",
  "runtime_index_manifests",
  "runtime_index_generations",
  "runtime_index_coverage",
  "runtime_media_segments",
  "runtime_segment_text",
  "runtime_segment_embeddings",
  "runtime_segment_fingerprints",
  "runtime_index_batches",
  "runtime_similarity_embeddings",
  "runtime_text_similarity_documents",
  "runtime_text_similarity_chunks",
] as const;

const CELLS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS cells (
    notebook_id TEXT NOT NULL
      REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    cell_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (
      type IN (
        'audio','image','video','extract_audio','extract_frame','split_video',
        'prompt','character',
        'analyze','analysis','generate_video','generate_image','generate_audio',
        'concat','splice'
      )
    ),
    label TEXT,
    grid_row INTEGER NOT NULL CHECK (grid_row BETWEEN 0 AND 25),
    grid_column INTEGER NOT NULL CHECK (grid_column BETWEEN 0 AND 12),
    output_entity_id TEXT
      REFERENCES entities(entity_id) ON DELETE RESTRICT,
    prompt TEXT,
    provider TEXT,
    model TEXT,
    operation TEXT,
    tool TEXT,
    inputs_json TEXT NOT NULL DEFAULT '{}',
    output_artifact_id TEXT
      REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    PRIMARY KEY(notebook_id, cell_id)
  );`;

export const SEMANTIC_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS engine_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS book (
    book_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    label TEXT,
    kind TEXT NOT NULL CHECK (
      kind IN (
        'video','image','audio','script','character',
        'prompt','scene','final'
      )
    ),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS objects (
    object_hash TEXT PRIMARY KEY,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    created_at INTEGER NOT NULL,
    forgotten_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS artifact_files (
    artifact_id TEXT NOT NULL
      REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    object_hash TEXT NOT NULL
      REFERENCES objects(object_hash) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(artifact_id, path)
  );
  CREATE TABLE IF NOT EXISTS artifact_streams (
    stream_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL
      REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    source_path TEXT NOT NULL,
    object_hash TEXT NOT NULL
      REFERENCES objects(object_hash) ON DELETE RESTRICT,
    stream_index INTEGER NOT NULL CHECK (stream_index >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('video','audio')),
    time_base_numerator INTEGER NOT NULL CHECK (time_base_numerator > 0),
    time_base_denominator INTEGER NOT NULL CHECK (time_base_denominator > 0),
    duration_ticks INTEGER NOT NULL CHECK (duration_ticks > 0),
    codec TEXT NOT NULL,
    profile_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    UNIQUE(artifact_id, source_path, object_hash, stream_index),
    FOREIGN KEY(artifact_id, source_path)
      REFERENCES artifact_files(artifact_id, path) ON DELETE RESTRICT
  );
  CREATE TABLE IF NOT EXISTS book_metadata (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifact_metadata (
    artifact_id TEXT NOT NULL
      REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    PRIMARY KEY(artifact_id, key)
  );

  CREATE TABLE IF NOT EXISTS entities (
    entity_id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('prompt','character','scene')),
    name TEXT NOT NULL,
    description TEXT,
    prompt TEXT,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notebooks (
    notebook_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notebook_fields (
    notebook_id TEXT NOT NULL
      REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    field TEXT NOT NULL CHECK (
      field IN (
        'description','lifecycle_state','workflow_version',
        'analysis_revision','fixture'
      )
    ),
    value_json TEXT NOT NULL,
    PRIMARY KEY(notebook_id, field)
  );
  ${CELLS_TABLE_SQL}
  CREATE TABLE IF NOT EXISTS notebook_cell_executions (
    notebook_id TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    fingerprint TEXT,
    status TEXT,
    output_artifact_id TEXT,
    provider_artifact_id TEXT,
    run_id TEXT,
    completed_at TEXT,
    started_at TEXT,
    updated_at TEXT,
    tool TEXT,
    error TEXT,
    stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
    fixture_baseline INTEGER NOT NULL DEFAULT 0
      CHECK (fixture_baseline IN (0, 1)),
    PRIMARY KEY(notebook_id, cell_id),
    FOREIGN KEY(notebook_id, cell_id)
      REFERENCES cells(notebook_id, cell_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS notebook_generation_plans (
    notebook_id TEXT NOT NULL
      REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    output_artifact_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(notebook_id, plan_id),
    FOREIGN KEY(notebook_id, cell_id)
      REFERENCES cells(notebook_id, cell_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS notebook_run_plans (
    notebook_id TEXT NOT NULL
      REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    paid_cell_ids_json TEXT NOT NULL,
    cell_fingerprints_json TEXT NOT NULL,
    known_cost_usd REAL NOT NULL CHECK (known_cost_usd >= 0),
    unknown_cost_count INTEGER NOT NULL CHECK (unknown_cost_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    run_id TEXT,
    outputs_json TEXT,
    error TEXT,
    PRIMARY KEY(notebook_id, plan_id)
  );
  CREATE TABLE IF NOT EXISTS edges (
    notebook_id TEXT NOT NULL
      REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    edge_id TEXT NOT NULL,
    source_cell_id TEXT NOT NULL,
    target_cell_id TEXT NOT NULL,
    target_input TEXT NOT NULL,
    PRIMARY KEY(notebook_id, edge_id),
    FOREIGN KEY(notebook_id, source_cell_id)
      REFERENCES cells(notebook_id, cell_id) ON DELETE CASCADE,
    FOREIGN KEY(notebook_id, target_cell_id)
      REFERENCES cells(notebook_id, cell_id) ON DELETE CASCADE,
    UNIQUE(notebook_id, target_cell_id, target_input)
  );
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL
      REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('completed','failed','aborted')),
    started_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    cell_order_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS cell_references (
    notebook_id TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (
      kind IN (
        'artifact','stream','source-range','transcript',
        'sequence','cell-output'
      )
    ),
    target_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY(notebook_id, cell_id, reference_id),
    FOREIGN KEY(notebook_id, cell_id)
      REFERENCES cells(notebook_id, cell_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS pinned_search_results (
    notebook_id TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    result_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL
      REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    object_hash TEXT NOT NULL
      REFERENCES objects(object_hash) ON DELETE RESTRICT,
    location_json TEXT NOT NULL,
    representative_json TEXT,
    query_json TEXT NOT NULL,
    signals_json TEXT NOT NULL,
    selected_revision TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(notebook_id, cell_id, result_id),
    FOREIGN KEY(notebook_id, cell_id)
      REFERENCES cells(notebook_id, cell_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS transcripts (
    transcript_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL
      REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    stream_id TEXT NOT NULL
      REFERENCES artifact_streams(stream_id) ON DELETE RESTRICT,
    object_hash TEXT NOT NULL
      REFERENCES objects(object_hash) ON DELETE RESTRICT,
    payload_hash TEXT NOT NULL
      REFERENCES objects(object_hash) ON DELETE RESTRICT,
    language TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    state TEXT NOT NULL CHECK (state IN ('current','derived')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transcripts_current
    ON transcripts(artifact_id, stream_id, object_hash, state);
  CREATE TABLE IF NOT EXISTS transcript_segments (
    segment_id TEXT PRIMARY KEY,
    transcript_id TEXT NOT NULL
      REFERENCES transcripts(transcript_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    start_tick INTEGER NOT NULL CHECK (start_tick >= 0),
    duration_ticks INTEGER NOT NULL CHECK (duration_ticks > 0),
    speaker TEXT,
    confidence REAL CHECK (
      confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
    ),
    kind TEXT NOT NULL CHECK (
      kind IN ('speech','music','sound','silence','other')
    ),
    UNIQUE(transcript_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS transcript_words (
    word_id TEXT PRIMARY KEY,
    segment_id TEXT NOT NULL
      REFERENCES transcript_segments(segment_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    start_tick INTEGER NOT NULL CHECK (start_tick >= 0),
    duration_ticks INTEGER NOT NULL CHECK (duration_ticks > 0),
    confidence REAL CHECK (
      confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
    ),
    corrected INTEGER NOT NULL DEFAULT 0 CHECK (corrected IN (0,1)),
    UNIQUE(segment_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS sequences (
    sequence_id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL
      REFERENCES book(book_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    pixel_aspect_numerator INTEGER NOT NULL
      CHECK (pixel_aspect_numerator > 0),
    pixel_aspect_denominator INTEGER NOT NULL
      CHECK (pixel_aspect_denominator > 0),
    frame_rate_numerator INTEGER NOT NULL
      CHECK (frame_rate_numerator > 0),
    frame_rate_denominator INTEGER NOT NULL
      CHECK (frame_rate_denominator > 0),
    audio_sample_rate_hz INTEGER NOT NULL CHECK (audio_sample_rate_hz > 0),
    audio_channel_layout TEXT NOT NULL,
    background_rgba_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sequences_primary
    ON sequences(book_id, is_primary);
  CREATE TABLE IF NOT EXISTS sequence_tracks (
    track_id TEXT PRIMARY KEY,
    sequence_id TEXT NOT NULL
      REFERENCES sequences(sequence_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('video','audio','caption')),
    order_key TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
    muted INTEGER CHECK (muted IS NULL OR muted IN (0,1)),
    solo INTEGER CHECK (solo IS NULL OR solo IN (0,1)),
    blend_mode TEXT,
    CHECK (
      (kind = 'audio' AND muted IS NOT NULL AND solo IS NOT NULL)
      OR (kind <> 'audio' AND muted IS NULL AND solo IS NULL)
    ),
    CHECK (
      (kind = 'video' AND blend_mode = 'normal')
      OR (kind <> 'video' AND blend_mode IS NULL)
    )
  );
  CREATE TABLE IF NOT EXISTS sequence_clips (
    clip_id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL
      REFERENCES sequence_tracks(track_id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('still','timed')),
    artifact_id TEXT NOT NULL
      REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    source_path TEXT,
    stream_id TEXT
      REFERENCES artifact_streams(stream_id) ON DELETE RESTRICT,
    object_hash TEXT NOT NULL
      REFERENCES objects(object_hash) ON DELETE RESTRICT,
    source_start_tick INTEGER,
    source_duration_ticks INTEGER,
    time_base_numerator INTEGER,
    time_base_denominator INTEGER,
    timeline_start_frame INTEGER NOT NULL CHECK (timeline_start_frame >= 0),
    duration_frames INTEGER NOT NULL CHECK (duration_frames > 0),
    speed_numerator INTEGER,
    speed_denominator INTEGER,
    reverse INTEGER,
    audio_policy TEXT,
    gain_db REAL,
    audio_muted INTEGER CHECK (audio_muted IS NULL OR audio_muted IN (0,1)),
    fade_in_frames INTEGER CHECK (fade_in_frames IS NULL OR fade_in_frames >= 0),
    fade_out_frames INTEGER CHECK (fade_out_frames IS NULL OR fade_out_frames >= 0),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    CHECK (
      (
        source_kind = 'still'
        AND source_path IS NOT NULL
        AND stream_id IS NULL
        AND source_start_tick IS NULL
        AND source_duration_ticks IS NULL
        AND time_base_numerator IS NULL
        AND time_base_denominator IS NULL
        AND speed_numerator IS NULL
        AND speed_denominator IS NULL
        AND reverse IS NULL
        AND audio_policy IS NULL
      )
      OR
      (
        source_kind = 'timed'
        AND source_path IS NULL
        AND stream_id IS NOT NULL
        AND source_start_tick >= 0
        AND source_duration_ticks > 0
        AND time_base_numerator > 0
        AND time_base_denominator > 0
        AND speed_numerator > 0
        AND speed_denominator > 0
        AND reverse IN (0,1)
        AND audio_policy IN ('preserve-pitch','resample','mute')
      )
    ),
    CHECK (
      (
        gain_db IS NULL
        AND audio_muted IS NULL
        AND fade_in_frames IS NULL
        AND fade_out_frames IS NULL
      )
      OR
      (
        gain_db IS NOT NULL
        AND audio_muted IS NOT NULL
        AND fade_in_frames IS NOT NULL
        AND fade_out_frames IS NOT NULL
      )
    )
  );
  CREATE TABLE IF NOT EXISTS clip_links (
    link_group_id TEXT NOT NULL,
    clip_id TEXT NOT NULL UNIQUE
      REFERENCES sequence_clips(clip_id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    PRIMARY KEY(link_group_id, clip_id)
  );
  CREATE TABLE IF NOT EXISTS clip_transforms (
    clip_id TEXT PRIMARY KEY
      REFERENCES sequence_clips(clip_id) ON DELETE CASCADE,
    fit TEXT NOT NULL CHECK (fit IN ('fit','fill','crop')),
    position_x REAL NOT NULL,
    position_y REAL NOT NULL,
    scale_x REAL NOT NULL CHECK (scale_x > 0),
    scale_y REAL NOT NULL CHECK (scale_y > 0),
    anchor_x REAL NOT NULL,
    anchor_y REAL NOT NULL,
    rotation_degrees REAL NOT NULL,
    crop_top REAL NOT NULL CHECK (crop_top >= 0 AND crop_top <= 1),
    crop_right REAL NOT NULL CHECK (crop_right >= 0 AND crop_right <= 1),
    crop_bottom REAL NOT NULL CHECK (crop_bottom >= 0 AND crop_bottom <= 1),
    crop_left REAL NOT NULL CHECK (crop_left >= 0 AND crop_left <= 1),
    opacity REAL NOT NULL CHECK (opacity >= 0 AND opacity <= 1),
    blend_mode TEXT NOT NULL CHECK (blend_mode = 'normal')
  );
  CREATE TABLE IF NOT EXISTS transitions (
    transition_id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL
      REFERENCES sequence_tracks(track_id) ON DELETE CASCADE,
    outgoing_clip_id TEXT NOT NULL
      REFERENCES sequence_clips(clip_id) ON DELETE CASCADE,
    incoming_clip_id TEXT NOT NULL
      REFERENCES sequence_clips(clip_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('cut','dissolve')),
    duration_frames INTEGER NOT NULL CHECK (duration_frames > 0),
    alignment TEXT NOT NULL CHECK (alignment IN ('start','center','end')),
    parameters_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(track_id, outgoing_clip_id, incoming_clip_id)
  );
  CREATE TABLE IF NOT EXISTS caption_cues (
    cue_id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL
      REFERENCES sequence_tracks(track_id) ON DELETE CASCADE,
    timeline_start_frame INTEGER NOT NULL CHECK (timeline_start_frame >= 0),
    duration_frames INTEGER NOT NULL CHECK (duration_frames > 0),
    text TEXT NOT NULL,
    speaker TEXT,
    style_id TEXT NOT NULL,
    transcript_id TEXT
      REFERENCES transcripts(transcript_id) ON DELETE RESTRICT,
    transcript_revision TEXT,
    start_word_id TEXT,
    end_word_id TEXT,
    source_range_json TEXT,
    CHECK (
      (
        transcript_id IS NULL
        AND transcript_revision IS NULL
        AND start_word_id IS NULL
        AND end_word_id IS NULL
        AND source_range_json IS NULL
      )
      OR
      (
        transcript_id IS NOT NULL
        AND transcript_revision IS NOT NULL
        AND start_word_id IS NOT NULL
        AND end_word_id IS NOT NULL
        AND source_range_json IS NOT NULL
      )
    )
  );
  CREATE TABLE IF NOT EXISTS audio_waveforms (
    artifact_id TEXT PRIMARY KEY
      REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    peaks_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompt_entries (
    prompt_id TEXT PRIMARY KEY,
    surface TEXT NOT NULL,
    prompt TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    body_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS artifacts_created
    ON artifacts(created_at, artifact_id);
  CREATE INDEX IF NOT EXISTS artifact_files_object
    ON artifact_files(object_hash);
  CREATE INDEX IF NOT EXISTS artifact_streams_artifact
    ON artifact_streams(artifact_id, source_path, stream_index);
  CREATE INDEX IF NOT EXISTS artifact_streams_object
    ON artifact_streams(object_hash, stream_id);
  CREATE INDEX IF NOT EXISTS entities_type_created
    ON entities(type, created_at, entity_id);
  CREATE INDEX IF NOT EXISTS notebooks_created
    ON notebooks(created_at, notebook_id);
  CREATE INDEX IF NOT EXISTS cells_output_entity
    ON cells(output_entity_id);
  CREATE INDEX IF NOT EXISTS notebook_generation_plans_cell
    ON notebook_generation_plans(notebook_id, cell_id, updated_at, plan_id);
  CREATE INDEX IF NOT EXISTS notebook_run_plans_updated
    ON notebook_run_plans(notebook_id, updated_at, plan_id);
  CREATE INDEX IF NOT EXISTS cells_grid
    ON cells(notebook_id, grid_row, grid_column, cell_id);
  CREATE INDEX IF NOT EXISTS cells_output_artifact
    ON cells(output_artifact_id);
  CREATE INDEX IF NOT EXISTS edges_source
    ON edges(notebook_id, source_cell_id);
  CREATE INDEX IF NOT EXISTS edges_target
    ON edges(notebook_id, target_cell_id);
  CREATE INDEX IF NOT EXISTS runs_notebook_completed
    ON runs(notebook_id, completed_at, run_id);
  CREATE INDEX IF NOT EXISTS cell_references_target
    ON cell_references(kind, target_id);
  CREATE INDEX IF NOT EXISTS pinned_search_results_artifact
    ON pinned_search_results(artifact_id, created_at, result_id);
  CREATE INDEX IF NOT EXISTS transcripts_artifact
    ON transcripts(artifact_id, stream_id, state, created_at);
  CREATE INDEX IF NOT EXISTS transcript_segments_order
    ON transcript_segments(transcript_id, ordinal);
  CREATE INDEX IF NOT EXISTS transcript_words_order
    ON transcript_words(segment_id, ordinal);
  CREATE INDEX IF NOT EXISTS sequence_tracks_order
    ON sequence_tracks(sequence_id, kind, order_key);
  CREATE INDEX IF NOT EXISTS sequence_clips_timeline
    ON sequence_clips(track_id, timeline_start_frame, clip_id);
  CREATE INDEX IF NOT EXISTS sequence_clips_artifact
    ON sequence_clips(artifact_id, object_hash);
  CREATE INDEX IF NOT EXISTS transitions_track
    ON transitions(track_id, outgoing_clip_id, incoming_clip_id);
  CREATE INDEX IF NOT EXISTS caption_cues_timeline
    ON caption_cues(track_id, timeline_start_frame, cue_id);
  CREATE INDEX IF NOT EXISTS prompt_entries_lookup
    ON prompt_entries(surface, created_at, prompt_id);
  CREATE INDEX IF NOT EXISTS messages_created
    ON messages(created_at, message_id);
`;

const RUNTIME_SIMILARITY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runtime_similarity_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio')),
    source_path TEXT NOT NULL,
    object_hash TEXT NOT NULL,
    embedding_space TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    frame_count INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE(artifact_id, embedding_space)
  );
  CREATE INDEX IF NOT EXISTS runtime_similarity_kind
    ON runtime_similarity_embeddings(kind, embedding_space, updated_at);
  CREATE INDEX IF NOT EXISTS runtime_similarity_object
    ON runtime_similarity_embeddings(object_hash, embedding_space);
`;

export const RUNTIME_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runtime_meta (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    type TEXT NOT NULL,
    artifact_id TEXT,
    external_task_id TEXT,
    state TEXT NOT NULL CHECK (
      state IN ('queued','running','completing','done','failed','aborted')
    ),
    payload_json TEXT NOT NULL,
    result_json TEXT,
    dedupe_key TEXT,
    enqueued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    pid INTEGER,
    lease_expires_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    error_json TEXT,
    fence INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS runtime_jobs_state
    ON runtime_jobs(state, enqueued_at);
  CREATE INDEX IF NOT EXISTS runtime_jobs_lease
    ON runtime_jobs(state, lease_expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_jobs_dedupe
    ON runtime_jobs(dedupe_key)
    WHERE dedupe_key IS NOT NULL
      AND state IN ('queued','running','completing');
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_jobs_external
    ON runtime_jobs(type, external_task_id)
    WHERE external_task_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS job_runs (
    run_id TEXT PRIMARY KEY,
    artifact_id TEXT,
    job_type TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('done','failed','aborted')),
    payload_json TEXT NOT NULL,
    result_json TEXT,
    error_json TEXT,
    started_at INTEGER,
    finished_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_resource_leases (
    lease_id TEXT PRIMARY KEY,
    artifact_id TEXT,
    resource_key TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    pid INTEGER,
    state TEXT,
    data_json TEXT NOT NULL DEFAULT '{}',
    fence INTEGER NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_resource_active
    ON runtime_resource_leases(resource_key)
    WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS runtime_resource_artifact
    ON runtime_resource_leases(artifact_id, revoked_at);

  CREATE TABLE IF NOT EXISTS runtime_object_publications (
    object_hash TEXT PRIMARY KEY,
    published_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_workspace_entries (
    artifact_id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    hydrated_at INTEGER,
    invalidated_at INTEGER,
    last_accessed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_artifact_views (
    artifact_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending','working','ready','error')),
    meta_json TEXT NOT NULL DEFAULT '{}',
    owner_id TEXT,
    owner_kind TEXT,
    pid INTEGER,
    deadline_at INTEGER,
    updated_at INTEGER NOT NULL,
    seen_at INTEGER,
    fence INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS runtime_pending_tasks (
    artifact_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    completing INTEGER NOT NULL DEFAULT 0,
    owner_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_pending_external
    ON runtime_pending_tasks(task_id);

  CREATE TABLE IF NOT EXISTS runtime_generation_errors (
    artifact_id TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    fail_code TEXT,
    prompt TEXT,
    failed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    body_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runtime_logs_lookup
    ON runtime_logs(name, created_at);

  CREATE TABLE IF NOT EXISTS runtime_commit_outbox (
    operation_id TEXT PRIMARY KEY,
    tables_json TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_index_manifests (
    manifest_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    model_revision TEXT NOT NULL,
    license TEXT,
    embedding_space TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions > 0),
    modalities_json TEXT NOT NULL,
    supported_languages_json TEXT NOT NULL,
    preprocessing_version TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_index_generations (
    embedding_space TEXT NOT NULL,
    generation TEXT NOT NULL,
    manifest_id TEXT NOT NULL
      REFERENCES runtime_index_manifests(manifest_id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('building','active','retired')),
    activated_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(embedding_space, generation)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_index_generation_active
    ON runtime_index_generations(embedding_space)
    WHERE state='active';

  CREATE TABLE IF NOT EXISTS runtime_index_coverage (
    artifact_id TEXT NOT NULL,
    object_hash TEXT NOT NULL,
    manifest_id TEXT NOT NULL
      REFERENCES runtime_index_manifests(manifest_id) ON DELETE CASCADE,
    generation TEXT NOT NULL,
    phase TEXT NOT NULL,
    state TEXT NOT NULL,
    covered_ranges_json TEXT NOT NULL,
    indexed_units INTEGER NOT NULL CHECK (indexed_units >= 0),
    total_units INTEGER,
    retryable INTEGER NOT NULL CHECK (retryable IN (0,1)),
    error_json TEXT,
    cursor TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(artifact_id, object_hash, manifest_id, generation, phase)
  );
  CREATE INDEX IF NOT EXISTS runtime_index_coverage_state
    ON runtime_index_coverage(generation, state, artifact_id);

  CREATE TABLE IF NOT EXISTS runtime_media_segments (
    segment_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    stream_id TEXT,
    object_hash TEXT NOT NULL,
    source_range_json TEXT,
    source_path TEXT,
    segment_kind TEXT NOT NULL,
    representative_tick INTEGER,
    segmentation_version TEXT NOT NULL,
    generation TEXT NOT NULL,
    manifest_id TEXT NOT NULL
      REFERENCES runtime_index_manifests(manifest_id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runtime_media_segments_source
    ON runtime_media_segments(
      generation, artifact_id, stream_id, representative_tick
    );

  CREATE TABLE IF NOT EXISTS runtime_segment_text (
    text_id TEXT PRIMARY KEY,
    segment_id TEXT NOT NULL
      REFERENCES runtime_media_segments(segment_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    language TEXT,
    text TEXT NOT NULL,
    start_utf8_byte INTEGER,
    end_utf8_byte INTEGER,
    confidence REAL,
    provenance_json TEXT NOT NULL,
    generation TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runtime_segment_text_lookup
    ON runtime_segment_text(generation, kind, segment_id);

  CREATE TABLE IF NOT EXISTS runtime_segment_embeddings (
    embedding_id TEXT PRIMARY KEY,
    segment_id TEXT NOT NULL
      REFERENCES runtime_media_segments(segment_id) ON DELETE CASCADE,
    modality TEXT NOT NULL,
    embedding_space TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    source_hash TEXT NOT NULL,
    generation TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(segment_id, modality, embedding_space, generation)
  );
  CREATE INDEX IF NOT EXISTS runtime_segment_embeddings_space
    ON runtime_segment_embeddings(
      generation, embedding_space, modality, segment_id
    );

  CREATE TABLE IF NOT EXISTS runtime_segment_fingerprints (
    fingerprint_id TEXT PRIMARY KEY,
    segment_id TEXT NOT NULL
      REFERENCES runtime_media_segments(segment_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    generation TEXT NOT NULL,
    UNIQUE(kind, value, extractor_version, segment_id)
  );
  CREATE INDEX IF NOT EXISTS runtime_segment_fingerprints_lookup
    ON runtime_segment_fingerprints(generation, kind, value);

  CREATE TABLE IF NOT EXISTS runtime_index_batches (
    batch_key TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    object_hash TEXT NOT NULL,
    manifest_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    phase TEXT NOT NULL,
    cursor TEXT,
    result_json TEXT NOT NULL,
    committed_at INTEGER NOT NULL
  );

  ${RUNTIME_SIMILARITY_SCHEMA_SQL}

  CREATE TABLE IF NOT EXISTS runtime_text_similarity_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    object_hash TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding_space TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(artifact_id, embedding_space)
  );
  CREATE INDEX IF NOT EXISTS runtime_text_similarity_lookup
    ON runtime_text_similarity_documents(embedding_space, updated_at);
  CREATE INDEX IF NOT EXISTS runtime_text_similarity_object
    ON runtime_text_similarity_documents(object_hash, embedding_space);
  CREATE INDEX IF NOT EXISTS runtime_text_similarity_content
    ON runtime_text_similarity_documents(content_hash, embedding_space);

  CREATE TABLE IF NOT EXISTS runtime_text_similarity_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL
      REFERENCES runtime_text_similarity_documents(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL,
    embedding_space TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(document_id, chunk_index)
  );
  CREATE INDEX IF NOT EXISTS runtime_text_similarity_chunk_lookup
    ON runtime_text_similarity_chunks(
      embedding_space, document_id, chunk_index
    );
  CREATE INDEX IF NOT EXISTS runtime_text_similarity_chunk_document
    ON runtime_text_similarity_chunks(document_id, chunk_index);
`;
