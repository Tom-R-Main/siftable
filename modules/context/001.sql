CREATE SCHEMA context;
CREATE TABLE context.notes (id uuid PRIMARY KEY REFERENCES foundation.entities(id),owner_id uuid NOT NULL,scope_id uuid,title text NOT NULL,body text NOT NULL,source text,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX notes_search ON context.notes USING gin(to_tsvector('english',title || ' ' || body));
CREATE TABLE context.revisions (id uuid PRIMARY KEY,owner_id uuid NOT NULL,scope_id uuid,note_id uuid NOT NULL REFERENCES context.notes(id),revision integer NOT NULL,body text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(note_id,revision));
CREATE TRIGGER revisions_immutable BEFORE UPDATE OR DELETE ON context.revisions FOR EACH ROW EXECUTE FUNCTION foundation.immutable();
CREATE TABLE context.packets (id uuid PRIMARY KEY REFERENCES foundation.entities(id),owner_id uuid NOT NULL,scope_id uuid,manifest jsonb NOT NULL,digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER packets_immutable BEFORE UPDATE OR DELETE ON context.packets FOR EACH ROW EXECUTE FUNCTION foundation.immutable();
INSERT INTO foundation.entity_types VALUES ('context.note','context'),('context.packet','context');
