CREATE SCHEMA extensions;
CREATE TABLE extensions.definitions (owner_id uuid NOT NULL,scope_id uuid,type text NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL,UNIQUE NULLS NOT DISTINCT(owner_id,scope_id,type,version));
CREATE TABLE extensions.objects (id uuid PRIMARY KEY REFERENCES foundation.entities(id),owner_id uuid NOT NULL,scope_id uuid,type text NOT NULL,version integer NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE extensions.relations (owner_id uuid NOT NULL,scope_id uuid,type text NOT NULL,source_type text NOT NULL,target_type text NOT NULL,UNIQUE NULLS NOT DISTINCT(owner_id,scope_id,type));
CREATE TRIGGER definitions_immutable BEFORE UPDATE OR DELETE ON extensions.definitions FOR EACH ROW EXECUTE FUNCTION foundation.immutable();
CREATE TRIGGER relations_immutable BEFORE UPDATE OR DELETE ON extensions.relations FOR EACH ROW EXECUTE FUNCTION foundation.immutable();
INSERT INTO foundation.entity_types VALUES ('extensions.object','extensions');
