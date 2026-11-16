CREATE SCHEMA projects;
CREATE TABLE projects.projects (id uuid PRIMARY KEY REFERENCES foundation.entities(id),owner_id uuid NOT NULL,scope_id uuid,title text NOT NULL,instructions text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO foundation.entity_types VALUES ('projects.project','projects');
