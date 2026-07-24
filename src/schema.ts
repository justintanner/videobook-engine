export const SCHEMA_VERSION = 4;

export const SEMANTIC_TABLES = [
  "engine_schema",
  "book",
  "artifacts",
  "objects",
  "artifact_files",
  "book_metadata",
  "artifact_metadata",
  "entities",
  "notebooks",
  "cells",
  "edges",
  "runs",
  "timeline",
  "timeline_slots",
  "timeline_audio",
  "audio_waveforms",
  "prompt_entries",
  "messages",
  "operations",
  "actions",
  "action_events",
  "action_parents",
  "action_artifacts",
  "action_write_set",
  "job_runs",
] as const;

export type SemanticTable = (typeof SEMANTIC_TABLES)[number];

export const RUNTIME_TABLES = [
  "runtime_meta",
  "runtime_jobs",
  "runtime_resource_leases",
  "runtime_object_publications",
  "runtime_workspace_entries",
  "runtime_artifact_views",
  "runtime_pending_tasks",
  "runtime_generation_errors",
  "runtime_settings",
  "runtime_logs",
  "runtime_commit_outbox",
  "runtime_similarity_embeddings",
  "runtime_text_similarity_documents",
  "runtime_text_similarity_chunks",
] as const;

export const SEMANTIC_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS engine_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS book (
    book_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
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
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifact_files (
    artifact_id TEXT NOT NULL
      REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    object_hash TEXT NOT NULL
      REFERENCES objects(object_hash) ON DELETE RESTRICT,
    mtime_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(artifact_id, path)
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
    properties_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cells (
    notebook_id TEXT NOT NULL
      REFERENCES notebooks(notebook_id) ON DELETE CASCADE,
    cell_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (
      type IN ('prompt','character','scene','asset','image','video')
    ),
    title TEXT NOT NULL,
    position_x REAL NOT NULL,
    position_y REAL NOT NULL,
    entity_id TEXT
      REFERENCES entities(entity_id) ON DELETE RESTRICT,
    prompt TEXT,
    model TEXT,
    inputs_json TEXT NOT NULL DEFAULT '{}',
    output_artifact_id TEXT
      REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    PRIMARY KEY(notebook_id, cell_id)
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
      REFERENCES cells(notebook_id, cell_id) ON DELETE CASCADE
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
  CREATE TABLE IF NOT EXISTS timeline (
    book_id TEXT PRIMARY KEY
      REFERENCES book(book_id) ON DELETE CASCADE,
    render TEXT NOT NULL DEFAULT 'landscape'
      CHECK (render IN ('landscape','portrait','square'))
  );

  CREATE TABLE IF NOT EXISTS timeline_slots (
    slot_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL
      REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    volume REAL CHECK (volume IS NULL OR volume >= 0),
    audio_fade_in REAL CHECK (audio_fade_in IS NULL OR audio_fade_in >= 0),
    audio_fade_out REAL CHECK (audio_fade_out IS NULL OR audio_fade_out >= 0)
  );
  CREATE TABLE IF NOT EXISTS timeline_audio (
    audio_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL
      REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    start_frame INTEGER NOT NULL CHECK (start_frame >= 0),
    duration_frames INTEGER NOT NULL CHECK (duration_frames > 0),
    volume REAL CHECK (volume IS NULL OR volume >= 0),
    fade_in REAL CHECK (fade_in IS NULL OR fade_in >= 0),
    fade_out REAL CHECK (fade_out IS NULL OR fade_out >= 0)
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
  CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    artifact_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    write_set_json TEXT NOT NULL DEFAULT '[]',
    base_revision TEXT,
    created_at INTEGER NOT NULL,
    author TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (
      scope IN ('book','artifact','layout','external','system')
    ),
    actor TEXT NOT NULL,
    lane TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (
      phase IN (
        'requested','started','completed','failed','cancelled','conflicted'
      )
    ),
    base_revision TEXT,
    target_artifact_id TEXT,
    target_action_id TEXT,
    layout_json TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS action_events (
    event_id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL
      REFERENCES actions(action_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (
      phase IN (
        'requested','started','completed','failed','cancelled','conflicted'
      )
    ),
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS action_parents (
    action_id TEXT NOT NULL
      REFERENCES actions(action_id) ON DELETE CASCADE,
    parent_action_id TEXT NOT NULL
      REFERENCES actions(action_id) ON DELETE RESTRICT,
    PRIMARY KEY(action_id, parent_action_id)
  );

  CREATE TABLE IF NOT EXISTS action_artifacts (
    action_id TEXT NOT NULL
      REFERENCES actions(action_id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('input','output')),
    PRIMARY KEY(action_id, artifact_id, direction)
  );

  CREATE TABLE IF NOT EXISTS action_write_set (
    action_id TEXT NOT NULL
      REFERENCES actions(action_id) ON DELETE CASCADE,
    resource TEXT NOT NULL,
    PRIMARY KEY(action_id, resource)
  );

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

  CREATE INDEX IF NOT EXISTS artifacts_created
    ON artifacts(created_at, artifact_id);
  CREATE INDEX IF NOT EXISTS artifact_files_object
    ON artifact_files(object_hash);
  CREATE INDEX IF NOT EXISTS entities_type_created
    ON entities(type, created_at, entity_id);
  CREATE INDEX IF NOT EXISTS notebooks_created
    ON notebooks(created_at, notebook_id);
  CREATE INDEX IF NOT EXISTS cells_entity
    ON cells(entity_id);
  CREATE INDEX IF NOT EXISTS cells_output_artifact
    ON cells(output_artifact_id);
  CREATE INDEX IF NOT EXISTS edges_source
    ON edges(notebook_id, source_cell_id);
  CREATE INDEX IF NOT EXISTS edges_target
    ON edges(notebook_id, target_cell_id);
  CREATE INDEX IF NOT EXISTS runs_notebook_completed
    ON runs(notebook_id, completed_at, run_id);
  CREATE INDEX IF NOT EXISTS timeline_slots_order
    ON timeline_slots(ordinal, slot_id);
  CREATE INDEX IF NOT EXISTS timeline_slots_artifact
    ON timeline_slots(artifact_id);
  CREATE INDEX IF NOT EXISTS timeline_audio_order
    ON timeline_audio(ordinal, audio_id);
  CREATE INDEX IF NOT EXISTS timeline_audio_artifact
    ON timeline_audio(artifact_id);
  CREATE INDEX IF NOT EXISTS prompt_entries_lookup
    ON prompt_entries(surface, created_at, prompt_id);
  CREATE INDEX IF NOT EXISTS messages_created
    ON messages(created_at, message_id);
  CREATE INDEX IF NOT EXISTS operations_created
    ON operations(created_at, operation_id);
  CREATE INDEX IF NOT EXISTS operations_artifact_created
    ON operations(artifact_id, created_at, operation_id);
  CREATE INDEX IF NOT EXISTS action_events_action_created
    ON action_events(action_id, created_at, event_id);
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
