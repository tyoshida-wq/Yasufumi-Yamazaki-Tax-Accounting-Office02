-- Make audio_base64 nullable in chunk_jobs table
-- This allows using R2 storage (r2_key) instead of inline base64

-- SQLite doesn't support ALTER COLUMN, so we need to recreate the table

-- Step 1: Create new table with audio_base64 nullable
CREATE TABLE chunk_jobs_new (
  task_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  r2_key TEXT,
  audio_base64 TEXT,  -- Now nullable
  size_bytes INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'completed', 'error')),
  last_error TEXT,
  processing_by TEXT,
  retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, chunk_index),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Step 2: Copy existing data (if any)
INSERT INTO chunk_jobs_new 
SELECT task_id, chunk_index, start_ms, end_ms, mime_type, r2_key, audio_base64, size_bytes, 
       attempts, status, last_error, processing_by, retry_at, created_at, updated_at
FROM chunk_jobs;

-- Step 3: Drop old table
DROP TABLE chunk_jobs;

-- Step 4: Rename new table
ALTER TABLE chunk_jobs_new RENAME TO chunk_jobs;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_chunk_jobs_status ON chunk_jobs(status);
CREATE INDEX IF NOT EXISTS idx_chunk_jobs_retry_at ON chunk_jobs(retry_at);
