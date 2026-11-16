CREATE SCHEMA foundation;
CREATE TABLE foundation.modules (id text PRIMARY KEY, version integer NOT NULL, checksum text NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE TABLE foundation.module_references (source_module text NOT NULL REFERENCES foundation.modules(id),target_module text NOT NULL REFERENCES foundation.modules(id),PRIMARY KEY(source_module,target_module));
CREATE TABLE foundation.principals (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, scope_id uuid, role text NOT NULL CHECK(role IN ('owner','agent')),
 token_hash text NOT NULL UNIQUE, permissions text[] NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE FUNCTION foundation.authenticate(digest text) RETURNS TABLE(id uuid, owner_id uuid, scope_id uuid, role text, permissions text[])
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, foundation AS $$
 SELECT id,owner_id,scope_id,role,permissions FROM foundation.principals WHERE token_hash=digest AND NOT revoked
$$;
REVOKE ALL ON FUNCTION foundation.authenticate(text) FROM PUBLIC;
CREATE FUNCTION foundation.visible(owner uuid, scope uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT owner = NULLIF(current_setting('app.owner_id',true),'')::uuid
 AND scope IS NOT DISTINCT FROM NULLIF(current_setting('app.scope_id',true),'')::uuid
$$;
CREATE TABLE foundation.entity_types (type text PRIMARY KEY, module text NOT NULL REFERENCES foundation.modules(id));
CREATE TABLE foundation.entities (id uuid PRIMARY KEY, owner_id uuid NOT NULL, scope_id uuid, type text NOT NULL REFERENCES foundation.entity_types(type));
CREATE TABLE foundation.links (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, scope_id uuid,
 source_id uuid NOT NULL REFERENCES foundation.entities(id), target_id uuid NOT NULL REFERENCES foundation.entities(id), relation text NOT NULL,
 UNIQUE(source_id,target_id,relation)
);
CREATE TABLE foundation.receipts (
 principal_id uuid NOT NULL, owner_id uuid NOT NULL, scope_id uuid, operation text NOT NULL, key text NOT NULL,
 fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(principal_id,operation,key)
);
CREATE TABLE foundation.audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_id uuid NOT NULL, scope_id uuid, principal_id uuid NOT NULL,
 operation text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION foundation.immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append_only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON foundation.audit FOR EACH ROW EXECUTE FUNCTION foundation.immutable();
CREATE TRIGGER receipts_immutable BEFORE UPDATE OR DELETE ON foundation.receipts FOR EACH ROW EXECUTE FUNCTION foundation.immutable();
