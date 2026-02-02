-- Initial schema for AI Meeting Minutes application
-- Migrating from KV to D1 for better query capabilities

-- Tasks table: Main task records
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  filename TEXT,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  processed_chunks INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  status TEXT NOT NULL CHECK(status IN ('initialized', 'transcribing', 'transcribed', 'summarizing', 'completed', 'error')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);

-- Chunks table: Transcription results for each audio chunk
CREATE TABLE IF NOT EXISTS chunks (
  task_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  raw_response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, chunk_index),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_task_id ON chunks(task_id);

-- Chunk jobs table: Processing queue for audio chunks
CREATE TABLE IF NOT EXISTS chunk_jobs (
  task_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  audio_base64 TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_chunk_jobs_status ON chunk_jobs(status);
CREATE INDEX IF NOT EXISTS idx_chunk_jobs_retry_at ON chunk_jobs(retry_at);

-- Chunk states table: Processing state tracking
CREATE TABLE IF NOT EXISTS chunk_states (
  task_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'completed', 'error')),
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, chunk_index),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Transcripts table: Full merged transcription text
CREATE TABLE IF NOT EXISTS transcripts (
  task_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Minutes table: Generated meeting minutes
CREATE TABLE IF NOT EXISTS minutes (
  task_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Logs table: Task processing logs
CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  context TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_timestamp ON task_logs(timestamp DESC);
