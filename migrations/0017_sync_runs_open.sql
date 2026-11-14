-- Finding abandoned sync runs (status still 'running' long after they started)
-- must not scan the whole table: sync_runs grows by 144 rows a day and the
-- lookup happens on every run. With this index the reaper reads only the rows
-- that are actually still open — normally none.
CREATE INDEX IF NOT EXISTS idx_sync_runs_open ON sync_runs(source, status, started_at);
