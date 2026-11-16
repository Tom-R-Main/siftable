CREATE SCHEMA work;
CREATE TABLE work.items (
 id uuid PRIMARY KEY REFERENCES foundation.entities(id), owner_id uuid NOT NULL, scope_id uuid,title text NOT NULL,description text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','running','needs_review','done','cancelled')),
 epoch integer NOT NULL DEFAULT 0, claim_principal uuid, claim_digest text, expires_at timestamptz,
 plan_version integer NOT NULL DEFAULT 1, summary text, accepted_by uuid,accepted_plan_version integer,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((status IN ('claimed','running') AND claim_principal IS NOT NULL AND claim_digest IS NOT NULL AND expires_at IS NOT NULL) OR (status NOT IN ('claimed','running') AND claim_principal IS NULL AND claim_digest IS NULL AND expires_at IS NULL))
);
CREATE TABLE work.plans (id uuid PRIMARY KEY,owner_id uuid NOT NULL,scope_id uuid,work_id uuid NOT NULL REFERENCES work.items(id),version integer NOT NULL CHECK(version>0),steps jsonb NOT NULL,reason text NOT NULL,actor uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(work_id,version));
CREATE TABLE work.evidence (id uuid PRIMARY KEY,sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,owner_id uuid NOT NULL,scope_id uuid,work_id uuid NOT NULL,plan_version integer NOT NULL,step_id uuid NOT NULL,attempt_id text NOT NULL,outcome text NOT NULL CHECK(outcome IN ('passed','failed','error')),output text NOT NULL,provenance text NOT NULL,submitted_by uuid NOT NULL,fingerprint text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(work_id,plan_version,step_id,attempt_id),FOREIGN KEY(work_id,plan_version) REFERENCES work.plans(work_id,version));
CREATE FUNCTION work.validate_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM work.plans p, jsonb_array_elements(p.steps) s WHERE p.work_id=NEW.work_id AND p.version=NEW.plan_version AND s->>'id'=NEW.step_id::text) THEN RAISE EXCEPTION 'unknown_step' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER evidence_step BEFORE INSERT ON work.evidence FOR EACH ROW EXECUTE FUNCTION work.validate_evidence();
CREATE TABLE work.dependencies (owner_id uuid NOT NULL,scope_id uuid,work_id uuid NOT NULL REFERENCES work.items(id),predecessor_id uuid NOT NULL REFERENCES work.items(id),gate text NOT NULL CHECK(gate IN ('done','commands_passed')),PRIMARY KEY(work_id,predecessor_id),CHECK(work_id<>predecessor_id));
CREATE TABLE work.events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,owner_id uuid NOT NULL,scope_id uuid,work_id uuid NOT NULL REFERENCES work.items(id),actor uuid NOT NULL,event text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON work.events FOR EACH ROW EXECUTE FUNCTION foundation.immutable();
CREATE TRIGGER plans_immutable BEFORE UPDATE OR DELETE ON work.plans FOR EACH ROW EXECUTE FUNCTION foundation.immutable();
CREATE TRIGGER evidence_immutable BEFORE UPDATE OR DELETE ON work.evidence FOR EACH ROW EXECUTE FUNCTION foundation.immutable();
INSERT INTO foundation.entity_types VALUES ('work.item','work');
