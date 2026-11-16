CREATE SCHEMA planning;
CREATE TABLE planning.tasks (id uuid PRIMARY KEY REFERENCES foundation.entities(id),owner_id uuid NOT NULL,scope_id uuid,project_id uuid NOT NULL REFERENCES projects.projects(id),title text NOT NULL,acceptance text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO foundation.entity_types VALUES ('planning.task','planning');
