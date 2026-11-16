ALTER TABLE planning.tasks ADD COLUMN revision integer NOT NULL DEFAULT 1, ADD COLUMN status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done','cancelled'));
