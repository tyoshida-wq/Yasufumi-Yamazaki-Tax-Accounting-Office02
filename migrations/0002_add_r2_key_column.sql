-- Add r2_key column to chunk_jobs table for R2 storage support
-- Migration to replace audio_base64 inline storage with R2 references

-- Add r2_key column (nullable initially for backward compatibility)
ALTER TABLE chunk_jobs ADD COLUMN r2_key TEXT;

-- Make audio_base64 nullable (since we'll use R2 instead)
-- Note: SQLite doesn't support ALTER COLUMN directly, but we can work with existing schema
-- New rows will use r2_key, old rows (if any) will keep audio_base64
