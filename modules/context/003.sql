CREATE TABLE context.index (
  entity_id uuid PRIMARY KEY REFERENCES foundation.entities(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  scope_id uuid,
  domain text NOT NULL CHECK (domain IN ('note', 'task', 'project', 'object')),
  entity_type text NOT NULL,
  project_id uuid,
  title text NOT NULL,
  body text NOT NULL,
  search_vector tsvector NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX context_index_search_vector_idx
  ON context.index USING gin (search_vector);

CREATE INDEX context_index_owner_domain_updated_idx
  ON context.index (owner_id, domain, updated_at DESC);

ALTER TABLE context.index ENABLE ROW LEVEL SECURITY;
ALTER TABLE context.index FORCE ROW LEVEL SECURITY;

CREATE POLICY scope_isolation ON context.index
  USING (foundation.visible(owner_id, scope_id))
  WITH CHECK (foundation.visible(owner_id, scope_id));

CREATE OR REPLACE FUNCTION context.sync_note_index()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_project_id uuid;
  v_updated_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM context.index WHERE entity_id = OLD.id;
    RETURN OLD;
  END IF;

  SELECT l.target_id INTO v_project_id
  FROM foundation.links l
  JOIN foundation.entities e ON e.id = l.target_id
  WHERE l.source_id = NEW.id
    AND l.relation = 'belongs_to'
    AND e.type = 'projects.project'
  LIMIT 1;

  v_updated_at := CASE
    WHEN TG_OP = 'INSERT' THEN COALESCE(NEW.created_at, clock_timestamp())
    ELSE clock_timestamp()
  END;

  INSERT INTO context.index (
    entity_id,
    owner_id,
    scope_id,
    domain,
    entity_type,
    project_id,
    title,
    body,
    search_vector,
    updated_at
  ) VALUES (
    NEW.id,
    NEW.owner_id,
    NEW.scope_id,
    'note',
    'context.note',
    v_project_id,
    NEW.title,
    NEW.body,
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A')
      || setweight(to_tsvector('english', COALESCE(NEW.body, '')), 'B')
      || setweight(to_tsvector('english', COALESCE(NEW.source, '')), 'C'),
    v_updated_at
  )
  ON CONFLICT (entity_id) DO UPDATE SET
    owner_id = EXCLUDED.owner_id,
    scope_id = EXCLUDED.scope_id,
    domain = EXCLUDED.domain,
    entity_type = EXCLUDED.entity_type,
    project_id = EXCLUDED.project_id,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    search_vector = EXCLUDED.search_vector,
    updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION context.sync_project_index()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM context.index WHERE entity_id = OLD.id;
    RETURN OLD;
  END IF;

  v_updated_at := CASE
    WHEN TG_OP = 'INSERT' THEN COALESCE(NEW.created_at, clock_timestamp())
    ELSE clock_timestamp()
  END;

  INSERT INTO context.index (
    entity_id,
    owner_id,
    scope_id,
    domain,
    entity_type,
    project_id,
    title,
    body,
    search_vector,
    updated_at
  ) VALUES (
    NEW.id,
    NEW.owner_id,
    NEW.scope_id,
    'project',
    'projects.project',
    NEW.id,
    NEW.title,
    NEW.instructions,
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A')
      || setweight(to_tsvector('english', COALESCE(NEW.instructions, '')), 'B'),
    v_updated_at
  )
  ON CONFLICT (entity_id) DO UPDATE SET
    owner_id = EXCLUDED.owner_id,
    scope_id = EXCLUDED.scope_id,
    domain = EXCLUDED.domain,
    entity_type = EXCLUDED.entity_type,
    project_id = EXCLUDED.project_id,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    search_vector = EXCLUDED.search_vector,
    updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION context.sync_task_index()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM context.index WHERE entity_id = OLD.id;
    RETURN OLD;
  END IF;

  v_updated_at := CASE
    WHEN TG_OP = 'INSERT' THEN COALESCE(NEW.created_at, clock_timestamp())
    ELSE clock_timestamp()
  END;

  INSERT INTO context.index (
    entity_id,
    owner_id,
    scope_id,
    domain,
    entity_type,
    project_id,
    title,
    body,
    search_vector,
    updated_at
  ) VALUES (
    NEW.id,
    NEW.owner_id,
    NEW.scope_id,
    'task',
    'planning.task',
    NEW.project_id,
    NEW.title,
    NEW.acceptance,
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A')
      || setweight(to_tsvector('english', COALESCE(NEW.acceptance, '')), 'B'),
    v_updated_at
  )
  ON CONFLICT (entity_id) DO UPDATE SET
    owner_id = EXCLUDED.owner_id,
    scope_id = EXCLUDED.scope_id,
    domain = EXCLUDED.domain,
    entity_type = EXCLUDED.entity_type,
    project_id = EXCLUDED.project_id,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    search_vector = EXCLUDED.search_vector,
    updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION context.sync_object_index()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_obj jsonb;
  v_title text;
  v_body text;
  v_updated_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM context.index WHERE entity_id = OLD.id;
    RETURN OLD;
  END IF;

  v_obj := CASE
    WHEN jsonb_typeof(NEW.data) = 'object' THEN NEW.data
    ELSE '{}'::jsonb
  END;

  v_title := COALESCE(
    NULLIF(BTRIM(v_obj->>'title'), ''),
    NULLIF(BTRIM(v_obj->>'name'), ''),
    NEW.type
  );

  SELECT COALESCE(string_agg(val, ' '), '')
  INTO v_body
  FROM (
    SELECT value AS val
    FROM jsonb_each_text(v_obj)
    ORDER BY key
  ) s;

  v_updated_at := CASE
    WHEN TG_OP = 'INSERT' THEN COALESCE(NEW.created_at, clock_timestamp())
    ELSE clock_timestamp()
  END;

  INSERT INTO context.index (
    entity_id,
    owner_id,
    scope_id,
    domain,
    entity_type,
    project_id,
    title,
    body,
    search_vector,
    updated_at
  ) VALUES (
    NEW.id,
    NEW.owner_id,
    NEW.scope_id,
    'object',
    NEW.type,
    NULL,
    v_title,
    v_body,
    setweight(to_tsvector('english', COALESCE(v_title, '')), 'A')
      || setweight(jsonb_to_tsvector('english', v_obj, '["string","numeric"]'), 'B')
      || setweight(to_tsvector('english', COALESCE(NEW.type, '')), 'C'),
    v_updated_at
  )
  ON CONFLICT (entity_id) DO UPDATE SET
    owner_id = EXCLUDED.owner_id,
    scope_id = EXCLUDED.scope_id,
    domain = EXCLUDED.domain,
    entity_type = EXCLUDED.entity_type,
    project_id = EXCLUDED.project_id,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    search_vector = EXCLUDED.search_vector,
    updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION context.sync_search_triggers()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  CREATE OR REPLACE TRIGGER context_notes_search_index
    AFTER INSERT OR UPDATE OR DELETE ON context.notes
    FOR EACH ROW EXECUTE FUNCTION context.sync_note_index();

  INSERT INTO context.index (
    entity_id,
    owner_id,
    scope_id,
    domain,
    entity_type,
    project_id,
    title,
    body,
    search_vector,
    updated_at
  )
  SELECT
    n.id,
    n.owner_id,
    n.scope_id,
    'note',
    'context.note',
    (
      SELECT l.target_id
      FROM foundation.links l
      JOIN foundation.entities e ON e.id = l.target_id
      WHERE l.source_id = n.id
        AND l.relation = 'belongs_to'
        AND e.type = 'projects.project'
      LIMIT 1
    ),
    n.title,
    n.body,
    setweight(to_tsvector('english', COALESCE(n.title, '')), 'A')
      || setweight(to_tsvector('english', COALESCE(n.body, '')), 'B')
      || setweight(to_tsvector('english', COALESCE(n.source, '')), 'C'),
    n.created_at
  FROM context.notes n
  ON CONFLICT (entity_id) DO NOTHING;

  IF to_regclass('projects.projects') IS NOT NULL THEN
    EXECUTE 'CREATE OR REPLACE TRIGGER projects_projects_search_index AFTER INSERT OR UPDATE OR DELETE ON projects.projects FOR EACH ROW EXECUTE FUNCTION context.sync_project_index()';
    EXECUTE $sql$
      INSERT INTO context.index (
        entity_id,
        owner_id,
        scope_id,
        domain,
        entity_type,
        project_id,
        title,
        body,
        search_vector,
        updated_at
      )
      SELECT
        p.id,
        p.owner_id,
        p.scope_id,
        'project',
        'projects.project',
        p.id,
        p.title,
        p.instructions,
        setweight(to_tsvector('english', COALESCE(p.title, '')), 'A')
          || setweight(to_tsvector('english', COALESCE(p.instructions, '')), 'B'),
        p.created_at
      FROM projects.projects p
      ON CONFLICT (entity_id) DO NOTHING
    $sql$;
  END IF;

  IF to_regclass('planning.tasks') IS NOT NULL THEN
    EXECUTE 'CREATE OR REPLACE TRIGGER planning_tasks_search_index AFTER INSERT OR UPDATE OR DELETE ON planning.tasks FOR EACH ROW EXECUTE FUNCTION context.sync_task_index()';
    EXECUTE $sql$
      INSERT INTO context.index (
        entity_id,
        owner_id,
        scope_id,
        domain,
        entity_type,
        project_id,
        title,
        body,
        search_vector,
        updated_at
      )
      SELECT
        t.id,
        t.owner_id,
        t.scope_id,
        'task',
        'planning.task',
        t.project_id,
        t.title,
        t.acceptance,
        setweight(to_tsvector('english', COALESCE(t.title, '')), 'A')
          || setweight(to_tsvector('english', COALESCE(t.acceptance, '')), 'B'),
        t.created_at
      FROM planning.tasks t
      ON CONFLICT (entity_id) DO NOTHING
    $sql$;
  END IF;

  IF to_regclass('extensions.objects') IS NOT NULL THEN
    EXECUTE 'CREATE OR REPLACE TRIGGER extensions_objects_search_index AFTER INSERT OR UPDATE OR DELETE ON extensions.objects FOR EACH ROW EXECUTE FUNCTION context.sync_object_index()';
    EXECUTE $sql$
      INSERT INTO context.index (
        entity_id,
        owner_id,
        scope_id,
        domain,
        entity_type,
        project_id,
        title,
        body,
        search_vector,
        updated_at
      )
      SELECT
        o.id,
        o.owner_id,
        o.scope_id,
        'object',
        o.type,
        NULL,
        COALESCE(
          NULLIF(BTRIM((CASE WHEN jsonb_typeof(o.data) = 'object' THEN o.data ELSE '{}'::jsonb END)->>'title'), ''),
          NULLIF(BTRIM((CASE WHEN jsonb_typeof(o.data) = 'object' THEN o.data ELSE '{}'::jsonb END)->>'name'), ''),
          o.type
        ),
        COALESCE(
          (
            SELECT string_agg(val, ' ')
            FROM (
              SELECT value AS val
              FROM jsonb_each_text(CASE WHEN jsonb_typeof(o.data) = 'object' THEN o.data ELSE '{}'::jsonb END)
              ORDER BY key
            ) s
          ),
          ''
        ),
        setweight(
          to_tsvector(
            'english',
            COALESCE(
              NULLIF(BTRIM((CASE WHEN jsonb_typeof(o.data) = 'object' THEN o.data ELSE '{}'::jsonb END)->>'title'), ''),
              NULLIF(BTRIM((CASE WHEN jsonb_typeof(o.data) = 'object' THEN o.data ELSE '{}'::jsonb END)->>'name'), ''),
              o.type
            )
          ),
          'A'
        )
          || setweight(
            jsonb_to_tsvector(
              'english',
              CASE WHEN jsonb_typeof(o.data) = 'object' THEN o.data ELSE '{}'::jsonb END,
              '["string","numeric"]'
            ),
            'B'
          )
          || setweight(to_tsvector('english', COALESCE(o.type, '')), 'C'),
        o.created_at
      FROM extensions.objects o
      ON CONFLICT (entity_id) DO NOTHING
    $sql$;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION context.sync_search_triggers() FROM PUBLIC;

SELECT context.sync_search_triggers();
