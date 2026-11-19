ALTER TABLE work.items
  ADD COLUMN rank integer NOT NULL DEFAULT 0,
  ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  ADD COLUMN labels text[] NOT NULL DEFAULT '{}';

CREATE INDEX work_items_owner_status_rank_created_idx
  ON work.items (owner_id, status, rank ASC, created_at ASC);
