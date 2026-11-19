CREATE SCHEMA memory;

CREATE TABLE memory.entries (
  id uuid PRIMARY KEY REFERENCES foundation.entities(id),
  owner_id uuid NOT NULL,
  scope_id uuid,
  project_id uuid NOT NULL REFERENCES projects.projects(id),
  title text NOT NULL,
  summary text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('invariant', 'architecture', 'decision', 'gotcha', 'convention', 'interface')),
  status text NOT NULL CHECK (status IN ('unreviewed', 'confirmed', 'needs_review', 'rejected', 'superseded')),
  paths text[] NOT NULL DEFAULT '{}',
  symbols text[] NOT NULL DEFAULT '{}',
  source_commit text,
  file_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
  fact_hash text NOT NULL,
  superseded_by uuid REFERENCES memory.entries(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX memory_entries_active_fact_hash_idx
  ON memory.entries (
    owner_id,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    project_id,
    fact_hash
  )
  WHERE status NOT IN ('rejected', 'superseded');

CREATE INDEX memory_entries_fts_idx
  ON memory.entries USING gin (to_tsvector('english', title || ' ' || summary));

CREATE INDEX memory_entries_paths_idx
  ON memory.entries USING gin (paths);

CREATE INDEX memory_entries_project_status_idx
  ON memory.entries (owner_id, project_id, status);

ALTER TABLE memory.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.entries FORCE ROW LEVEL SECURITY;

CREATE POLICY scope_isolation ON memory.entries
  USING (foundation.visible(owner_id, scope_id))
  WITH CHECK (foundation.visible(owner_id, scope_id));

CREATE TABLE memory.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL,
  scope_id uuid,
  memory_id uuid NOT NULL REFERENCES memory.entries(id),
  actor uuid NOT NULL,
  event text NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX memory_events_memory_id_idx
  ON memory.events (memory_id, id);

CREATE TRIGGER memory_events_immutable
  BEFORE UPDATE OR DELETE ON memory.events
  FOR EACH ROW EXECUTE FUNCTION foundation.immutable();

ALTER TABLE memory.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory.events FORCE ROW LEVEL SECURITY;

CREATE POLICY scope_isolation ON memory.events
  USING (foundation.visible(owner_id, scope_id))
  WITH CHECK (foundation.visible(owner_id, scope_id));

INSERT INTO foundation.entity_types VALUES ('memory.entry', 'memory');
