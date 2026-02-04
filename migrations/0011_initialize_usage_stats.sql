-- 既存データから usage_stats を初期化
UPDATE usage_stats SET
  total_tasks = (SELECT COUNT(*) FROM tasks),
  total_audio_duration_ms = (SELECT COALESCE(SUM(duration_ms), 0) FROM tasks),
  total_chunks_processed = (SELECT COUNT(*) FROM chunk_states WHERE status = 'completed'),
  total_transcripts_generated = (SELECT COUNT(*) FROM transcripts),
  total_minutes_generated = (SELECT COUNT(*) FROM minutes),
  total_transcript_characters = (SELECT COALESCE(SUM(LENGTH(content)), 0) FROM transcripts),
  gemini_transcription_calls = (SELECT COUNT(*) FROM chunk_states WHERE status = 'completed'),
  gemini_minutes_calls = (SELECT COUNT(*) FROM minutes),
  total_api_errors = (SELECT COUNT(*) FROM chunk_states WHERE status = 'error'),
  total_r2_bytes = 0,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 1;
