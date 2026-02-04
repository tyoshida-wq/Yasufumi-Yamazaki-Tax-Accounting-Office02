-- 使用統計テーブル（シングルトン）
CREATE TABLE IF NOT EXISTS usage_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  
  -- 基本統計
  total_tasks INTEGER DEFAULT 0,
  total_audio_duration_ms INTEGER DEFAULT 0,
  total_chunks_processed INTEGER DEFAULT 0,
  total_transcripts_generated INTEGER DEFAULT 0,
  total_minutes_generated INTEGER DEFAULT 0,
  total_transcript_characters INTEGER DEFAULT 0,
  
  -- API使用統計
  gemini_transcription_calls INTEGER DEFAULT 0,
  gemini_minutes_calls INTEGER DEFAULT 0,
  total_api_errors INTEGER DEFAULT 0,
  
  -- ストレージ統計
  total_r2_bytes INTEGER DEFAULT 0,
  
  -- タイムスタンプ
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 初期データ挿入
INSERT OR IGNORE INTO usage_stats (id) VALUES (1);

-- 日別使用統計テーブル
CREATE TABLE IF NOT EXISTS daily_usage_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  
  -- 日別統計
  tasks_count INTEGER DEFAULT 0,
  audio_duration_ms INTEGER DEFAULT 0,
  chunks_processed INTEGER DEFAULT 0,
  transcripts_generated INTEGER DEFAULT 0,
  minutes_generated INTEGER DEFAULT 0,
  transcript_characters INTEGER DEFAULT 0,
  
  -- API使用
  gemini_calls INTEGER DEFAULT 0,
  api_errors INTEGER DEFAULT 0,
  
  -- ストレージ
  r2_bytes_added INTEGER DEFAULT 0,
  
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage_stats(date);
