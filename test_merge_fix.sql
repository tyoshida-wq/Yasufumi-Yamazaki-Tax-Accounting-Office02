-- Re-merge the existing 78-minute task to verify the fix
-- Task ID: ea447545-abf8-46e2-a894-7fb92228410f

-- First, check current transcript status
SELECT 
  'Current Status' as check_type,
  id,
  filename,
  total_chunks,
  processed_chunks,
  status,
  SUBSTR(content, LENGTH(content) - 200, 200) as last_200_chars
FROM tasks t
LEFT JOIN transcripts tr ON t.id = tr.task_id
WHERE t.id = 'ea447545-abf8-46e2-a894-7fb92228410f';

-- Show last chunk to verify all data exists
SELECT
  'Last Chunk Status' as check_type,
  chunk_index,
  start_ms / 1000.0 / 60 as start_min,
  end_ms / 1000.0 / 60 as end_min,
  LENGTH(text) as text_length,
  SUBSTR(text, LENGTH(text) - 200, 200) as last_200_chars
FROM chunks
WHERE task_id = 'ea447545-abf8-46e2-a894-7fb92228410f'
ORDER BY chunk_index DESC
LIMIT 1;
