ALTER TABLE work.items DROP CONSTRAINT items_status_check;
ALTER TABLE work.items ADD CONSTRAINT items_status_check CHECK(status IN ('queued','claimed','running','blocked','failed','needs_review','done','cancelled'));
ALTER TABLE work.items ADD COLUMN revision integer NOT NULL DEFAULT 1;
CREATE TABLE work.artifacts(id uuid PRIMARY KEY, owner_id uuid NOT NULL, scope_id uuid, work_id uuid NOT NULL REFERENCES work.items(id), plan_version integer NOT NULL, name text NOT NULL, media_type text NOT NULL, content text NOT NULL, digest text NOT NULL, actor uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(work_id,plan_version) REFERENCES work.plans(work_id,version));
CREATE TRIGGER immutable_artifacts BEFORE UPDATE OR DELETE ON work.artifacts FOR EACH ROW EXECUTE FUNCTION foundation.immutable();
