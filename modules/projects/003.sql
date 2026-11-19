CREATE TABLE projects.bindings (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  scope_id uuid,
  project_id uuid NOT NULL REFERENCES projects.projects(id),
  root_path text NOT NULL,
  git_remote_url text,
  default_branch text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX bindings_owner_scope_root_path_idx
  ON projects.bindings (owner_id, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), root_path);
CREATE INDEX bindings_project_id_idx
  ON projects.bindings (project_id);
CREATE INDEX bindings_owner_remote_idx
  ON projects.bindings (owner_id, git_remote_url)
  WHERE git_remote_url IS NOT NULL;
ALTER TABLE projects.bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_isolation ON projects.bindings
  USING (foundation.visible(owner_id, scope_id))
  WITH CHECK (foundation.visible(owner_id, scope_id));
