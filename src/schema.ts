export const SCHEMA_VERSION = 2;

export const SEMANTIC_TABLES = [
  "engine_schema",
  "projects",
  "artifacts",
  "objects",
  "artifact_files",
  "project_metadata",
  "artifact_metadata",
  "entities",
  "notebooks",
  "notebook_cells",
  "notebook_edges",
  "notebook_runs",
  "timelines",
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
  "artifact_events",
  "job_runs",
] as const;

export type SemanticTable = (typeof SEMANTIC_TABLES)[number];

export const RUNTIME_TABLES = [
  "runtime_meta",
  "runtime_engine_leases",
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
] as const;

export const SEMANTIC_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS engine_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS projects_active_slug
    ON projects(slug)
    WHERE deleted_at IS NULL;

  CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    slug TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (
      kind IN (
        'video','image','audio','script','character',
        'prompt','scene','notebook','final'
      )
    ),
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS artifacts_active_slug
    ON artifacts(project_id, slug)
    WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS artifacts_project_created
    ON artifacts(project_id, created_at);

  CREATE TABLE IF NOT EXISTS objects (
    object_hash TEXT PRIMARY KEY,
    size_bytes INTEGER NOT NULL,
    mime_type TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifact_files (
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
    path TEXT NOT NULL,
    object_hash TEXT NOT NULL REFERENCES objects(object_hash),
    size_bytes INTEGER NOT NULL,
    mime_type TEXT,
    mtime_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(artifact_id, path)
  );
  CREATE INDEX IF NOT EXISTS artifact_files_object
    ON artifact_files(object_hash);

  CREATE TABLE IF NOT EXISTS project_metadata (
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, key)
  );

  CREATE TABLE IF NOT EXISTS artifact_metadata (
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(artifact_id, key)
  );

  CREATE TABLE IF NOT EXISTS entities (
    entity_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    type TEXT NOT NULL CHECK (type IN ('prompt','character','scene')),
    name TEXT NOT NULL,
    description TEXT,
    prompt TEXT,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS entities_project_type
    ON entities(project_id, type, created_at);

  CREATE TABLE IF NOT EXISTS notebooks (
    notebook_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    properties_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS notebooks_project_created
    ON notebooks(project_id, created_at);

  CREATE TABLE IF NOT EXISTS notebook_cells (
    notebook_id TEXT NOT NULL REFERENCES notebooks(notebook_id),
    cell_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    position_x REAL NOT NULL,
    position_y REAL NOT NULL,
    entity_id TEXT,
    prompt TEXT,
    model TEXT,
    inputs_json TEXT NOT NULL DEFAULT '{}',
    output_artifact_id TEXT,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY(notebook_id, cell_id)
  );

  CREATE TABLE IF NOT EXISTS notebook_edges (
    notebook_id TEXT NOT NULL REFERENCES notebooks(notebook_id),
    edge_id TEXT NOT NULL,
    source_cell_id TEXT NOT NULL,
    target_cell_id TEXT NOT NULL,
    target_input TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY(notebook_id, edge_id)
  );

  CREATE TABLE IF NOT EXISTS notebook_runs (
    run_id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(notebook_id),
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    cell_order_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS timelines (
    project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
    render TEXT NOT NULL DEFAULT 'landscape',
    data_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS timeline_slots (
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    slot_id TEXT NOT NULL,
    artifact_id TEXT,
    ordinal INTEGER NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY(project_id, slot_id)
  );

  CREATE TABLE IF NOT EXISTS timeline_audio (
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    audio_id TEXT NOT NULL,
    artifact_id TEXT,
    ordinal INTEGER NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY(project_id, audio_id)
  );

  CREATE TABLE IF NOT EXISTS audio_waveforms (
    artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id),
    peaks_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompt_entries (
    prompt_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    surface TEXT NOT NULL,
    prompt TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS prompt_entries_lookup
    ON prompt_entries(project_id, surface, created_at);

  CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    role TEXT NOT NULL,
    body_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_project_created
    ON messages(project_id, created_at);

  CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    operation TEXT NOT NULL,
    artifact_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    write_set_json TEXT NOT NULL DEFAULT '[]',
    base_revision TEXT,
    created_at INTEGER NOT NULL,
    author TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS operations_project_created
    ON operations(project_id, created_at);
  CREATE INDEX IF NOT EXISTS operations_artifact_created
    ON operations(artifact_id, created_at);

  CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    operation TEXT NOT NULL,
    scope TEXT NOT NULL,
    actor TEXT NOT NULL,
    lane TEXT NOT NULL,
    phase TEXT NOT NULL,
    base_revision TEXT,
    target_artifact_id TEXT,
    target_action_id TEXT,
    layout_json TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS action_events (
    event_id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES actions(action_id),
    operation_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS action_parents (
    action_id TEXT NOT NULL REFERENCES actions(action_id),
    parent_action_id TEXT NOT NULL,
    PRIMARY KEY(action_id, parent_action_id)
  );

  CREATE TABLE IF NOT EXISTS action_artifacts (
    action_id TEXT NOT NULL REFERENCES actions(action_id),
    artifact_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('input','output')),
    PRIMARY KEY(action_id, artifact_id, direction)
  );

  CREATE TABLE IF NOT EXISTS action_write_set (
    action_id TEXT NOT NULL REFERENCES actions(action_id),
    resource TEXT NOT NULL,
    PRIMARY KEY(action_id, resource)
  );

  CREATE TABLE IF NOT EXISTS artifact_events (
    event_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
    operation_id TEXT NOT NULL,
    event TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_runs (
    run_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    artifact_id TEXT,
    job_type TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('done','failed','aborted')),
    payload_json TEXT NOT NULL,
    result_json TEXT,
    error_json TEXT,
    started_at INTEGER,
    finished_at INTEGER NOT NULL
  );
`;

export const RUNTIME_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runtime_meta (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_engine_leases (
    lease_name TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    fence INTEGER NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
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
    ON runtime_jobs(project_id, state, enqueued_at);
  CREATE INDEX IF NOT EXISTS runtime_jobs_lease
    ON runtime_jobs(state, lease_expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_jobs_dedupe
    ON runtime_jobs(project_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL
      AND state IN ('queued','running','completing');
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_jobs_external
    ON runtime_jobs(project_id, type, external_task_id)
    WHERE external_task_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS runtime_resource_leases (
    lease_id TEXT PRIMARY KEY,
    project_id TEXT,
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
    project_id TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    hydrated_at INTEGER,
    invalidated_at INTEGER,
    last_accessed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_artifact_views (
    artifact_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
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
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    completing INTEGER NOT NULL DEFAULT 0,
    owner_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS runtime_pending_external
    ON runtime_pending_tasks(project_id, task_id);

  CREATE TABLE IF NOT EXISTS runtime_generation_errors (
    artifact_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
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
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    body_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runtime_logs_lookup
    ON runtime_logs(project_id, name, created_at);

  CREATE TABLE IF NOT EXISTS runtime_commit_outbox (
    operation_id TEXT PRIMARY KEY,
    tables_json TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runtime_similarity_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    source_path TEXT NOT NULL,
    object_hash TEXT NOT NULL,
    embedding_space TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    frame_count INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE(artifact_id, embedding_space)
  );
  CREATE INDEX IF NOT EXISTS runtime_similarity_project_kind
    ON runtime_similarity_embeddings(
      project_id, kind, embedding_space, updated_at
    );
  CREATE INDEX IF NOT EXISTS runtime_similarity_object
    ON runtime_similarity_embeddings(object_hash, embedding_space);
`;
