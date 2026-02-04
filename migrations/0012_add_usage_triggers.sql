-- タスク作成時に統計を更新
CREATE TRIGGER IF NOT EXISTS update_stats_on_task_create
AFTER INSERT ON tasks
BEGIN
  UPDATE usage_stats SET 
    total_tasks = total_tasks + 1,
    total_audio_duration_ms = total_audio_duration_ms + COALESCE(NEW.duration_ms, 0),
    updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
  
  -- 日別統計も更新
  INSERT INTO daily_usage_stats (date, tasks_count, audio_duration_ms, updated_at)
  VALUES (DATE('now'), 1, COALESCE(NEW.duration_ms, 0), CURRENT_TIMESTAMP)
  ON CONFLICT(date) DO UPDATE SET
    tasks_count = tasks_count + 1,
    audio_duration_ms = audio_duration_ms + COALESCE(NEW.duration_ms, 0),
    updated_at = CURRENT_TIMESTAMP;
END;

-- チャンク状態が完了になった時に統計を更新
CREATE TRIGGER IF NOT EXISTS update_stats_on_chunk_state_complete
AFTER UPDATE ON chunk_states
WHEN NEW.status = 'completed' AND OLD.status != 'completed'
BEGIN
  UPDATE usage_stats SET 
    total_chunks_processed = total_chunks_processed + 1,
    gemini_transcription_calls = gemini_transcription_calls + 1,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
  
  -- 日別統計も更新
  INSERT INTO daily_usage_stats (date, chunks_processed, gemini_calls, updated_at)
  VALUES (DATE('now'), 1, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(date) DO UPDATE SET
    chunks_processed = chunks_processed + 1,
    gemini_calls = gemini_calls + 1,
    updated_at = CURRENT_TIMESTAMP;
END;

-- チャンク結果が挿入された時に文字数を更新
CREATE TRIGGER IF NOT EXISTS update_stats_on_chunk_insert
AFTER INSERT ON chunks
BEGIN
  UPDATE usage_stats SET 
    total_transcript_characters = total_transcript_characters + COALESCE(LENGTH(NEW.text), 0),
    updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
  
  -- 日別統計も更新
  INSERT INTO daily_usage_stats (date, transcript_characters, updated_at)
  VALUES (DATE('now'), COALESCE(LENGTH(NEW.text), 0), CURRENT_TIMESTAMP)
  ON CONFLICT(date) DO UPDATE SET
    transcript_characters = transcript_characters + COALESCE(LENGTH(NEW.text), 0),
    updated_at = CURRENT_TIMESTAMP;
END;

-- 文字起こし完了時に統計を更新
CREATE TRIGGER IF NOT EXISTS update_stats_on_transcript_create
AFTER INSERT ON transcripts
BEGIN
  UPDATE usage_stats SET 
    total_transcripts_generated = total_transcripts_generated + 1,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
  
  -- 日別統計も更新
  INSERT INTO daily_usage_stats (date, transcripts_generated, updated_at)
  VALUES (DATE('now'), 1, CURRENT_TIMESTAMP)
  ON CONFLICT(date) DO UPDATE SET
    transcripts_generated = transcripts_generated + 1,
    updated_at = CURRENT_TIMESTAMP;
END;

-- 議事録生成時に統計を更新
CREATE TRIGGER IF NOT EXISTS update_stats_on_minutes_create
AFTER INSERT ON minutes
BEGIN
  UPDATE usage_stats SET 
    total_minutes_generated = total_minutes_generated + 1,
    gemini_minutes_calls = gemini_minutes_calls + 1,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
  
  -- 日別統計も更新
  INSERT INTO daily_usage_stats (date, minutes_generated, gemini_calls, updated_at)
  VALUES (DATE('now'), 1, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(date) DO UPDATE SET
    minutes_generated = minutes_generated + 1,
    gemini_calls = gemini_calls + 1,
    updated_at = CURRENT_TIMESTAMP;
END;

-- チャンク状態がエラーになった時に統計を更新
CREATE TRIGGER IF NOT EXISTS update_stats_on_chunk_state_error
AFTER UPDATE ON chunk_states
WHEN NEW.status = 'error' AND OLD.status != 'error'
BEGIN
  UPDATE usage_stats SET 
    total_api_errors = total_api_errors + 1,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
  
  -- 日別統計も更新
  INSERT INTO daily_usage_stats (date, api_errors, updated_at)
  VALUES (DATE('now'), 1, CURRENT_TIMESTAMP)
  ON CONFLICT(date) DO UPDATE SET
    api_errors = api_errors + 1,
    updated_at = CURRENT_TIMESTAMP;
END;
