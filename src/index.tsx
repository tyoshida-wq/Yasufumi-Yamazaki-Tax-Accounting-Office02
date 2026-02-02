import { Hono } from 'hono'
import { cors } from 'hono/cors'

const GEMINI_FLASH_MODEL = 'gemini-3.0-flash-preview'
const GEMINI_PRO_MODEL = 'gemini-3.0-pro-preview'
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com'

const TIMESTAMP_PATTERN = /^\s*(\d{2}):(\d{2})(?::(\d{2}))?/ // Supports mm:ss or hh:mm:ss

const GEMINI_FLASH_TIMEOUT_MS = 60_000
const GEMINI_PRO_TIMEOUT_MS = 90_000
const GEMINI_FLASH_MAX_RETRIES = 4
const GEMINI_PRO_MAX_RETRIES = 3
const GEMINI_BACKOFF_BASE_MS = 2_000
const GEMINI_RETRYABLE_STATUS_CODES = new Set<number>([408, 429, 500, 502, 503, 504, 524])
const TASK_LOG_LIMIT = 200
const DEFAULT_CHUNK_SIZE_BYTES = 1 * 1024 * 1024
const DEFAULT_CHUNK_OVERLAP_SECONDS = 5
const DEFAULT_TRANSCRIPTION_CONCURRENCY = 4
const DEFAULT_CHUNK_JOB_MAX_ATTEMPTS = 6
const DEFAULT_UPLOAD_CONCURRENCY = 3
const CHUNK_QUEUE_BATCH_MULTIPLIER = 2
const MAX_CONCURRENCY_LIMIT = 8
const MAX_CHUNK_JOB_ATTEMPTS_LIMIT = 12

interface Bindings {
  GEMINI_API_KEY: string
  DB: D1Database
  AUDIO_CHUNKS: R2Bucket
  TRANSCRIPTION_QUEUE: Queue<ChunkJobMessage>
  ASSETS: Fetcher
  CHUNK_SIZE_BYTES?: string
  CHUNK_OVERLAP_SECONDS?: string
  TRANSCRIPTION_MAX_CONCURRENCY?: string
  CHUNK_JOB_MAX_ATTEMPTS?: string
  UPLOAD_CONCURRENCY?: string
}

type TaskLogLevel = 'info' | 'warn' | 'error'

type TaskLogEntry = {
  timestamp: string
  level: TaskLogLevel
  message: string
  context?: Record<string, unknown>
}

type TaskLogInput = Omit<TaskLogEntry, 'timestamp'> & { timestamp?: string }

type ChunkJobMessage = {
  taskId: string
  chunkIndex: number
  r2Key: string
  startMs: number
  endMs: number
  mimeType: string
  sizeBytes: number
}

type TaskStatus =
  | 'initialized'
  | 'transcribing'
  | 'transcribed'
  | 'summarizing'
  | 'completed'
  | 'error'

type TaskRecord = {
  id: string
  filename?: string
  totalChunks: number
  processedChunks: number
  durationMs?: number
  status: TaskStatus
  createdAt: string
  updatedAt: string
  error?: string
}

type ChunkRecord = {
  index: number
  startMs: number
  endMs: number
  text: string
  rawResponse?: unknown
  createdAt: string
}

type MinutesRecord = {
  content: string
  createdAt: string
}

type ChunkJobStatus = 'queued' | 'processing' | 'completed' | 'error'

type ChunkJobRecord = {
  index: number
  startMs: number
  endMs: number
  mimeType: string
  audioBase64: string
  sizeBytes: number
  attempts: number
  status: ChunkJobStatus
  createdAt: string
  updatedAt: string
  lastError?: string
  processingBy?: string
  retryAt?: string
}

type ChunkStateRecord = {
  index: number
  status: ChunkJobStatus
  attempts: number
  updatedAt: string
  lastError?: string
}

type ChunkSummary = {
  total: number
  queued: number
  processing: number
  completed: number
  error: number
}

type ProcessQueueOptions = {
  maxIterations?: number
}

type EnqueueChunkJobInput = {
  index: number
  startMs: number
  endMs: number
  mimeType: string
  audioBase64: string
  sizeBytes: number
}

type RuntimeConfig = {
  chunkSizeBytes: number
  overlapSeconds: number
  transcriptionConcurrency: number
  chunkJobMaxAttempts: number
  uploadConcurrency: number
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// Serve static files from Assets
app.get('/static/*', async (c) => {
  const url = new URL(c.req.url)
  return c.env.ASSETS.fetch(url)
})

app.get('/', async (c) => {
  return c.env.ASSETS.fetch(new URL('/index.html', c.req.url))
})

app.get('/favicon.ico', async (c) => {
  return c.env.ASSETS.fetch(new URL('/favicon.ico', c.req.url))
})

app.get('/api/config', (c) => {
  const config = getRuntimeConfig(c.env)
  return c.json({
    chunkSizeBytes: config.chunkSizeBytes,
    overlapSeconds: config.overlapSeconds,
    transcriptionConcurrency: config.transcriptionConcurrency,
    chunkJobMaxAttempts: config.chunkJobMaxAttempts,
    uploadConcurrency: config.uploadConcurrency,
    geminiFlashTimeoutMs: GEMINI_FLASH_TIMEOUT_MS,
    geminiProTimeoutMs: GEMINI_PRO_TIMEOUT_MS
  })
})

app.post('/api/tasks', async (c) => {
  const payload = await c.req.json().catch(() => null)
  if (!payload || typeof payload.totalChunks !== 'number' || payload.totalChunks <= 0) {
    return c.json({ error: 'totalChunks is required and must be greater than 0' }, 400)
  }

  const taskId = crypto.randomUUID()
  const now = new Date().toISOString()
  const filename = typeof payload.filename === 'string' ? payload.filename : null
  const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : null
  
  await c.env.DB.prepare(
    'INSERT INTO tasks (id, filename, total_chunks, processed_chunks, duration_ms, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(taskId, filename, payload.totalChunks, 0, durationMs, 'initialized', now, now).run()
  
  const task: TaskRecord = {
    id: taskId,
    filename: filename || undefined,
    totalChunks: payload.totalChunks,
    processedChunks: 0,
    durationMs: durationMs || undefined,
    status: 'initialized',
    createdAt: now,
    updatedAt: now
  }
  
  await appendTaskLog(c.env, taskId, {
    level: 'info',
    message: 'Task created',
    context: {
      totalChunks: task.totalChunks,
      filename: task.filename,
      durationMs: task.durationMs
    }
  })

  return c.json({ task })
})

app.get('/api/tasks/:taskId/status', async (c) => {
  const taskId = c.req.param('taskId')
  const task = await getTask(c.env, taskId)
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  const transcriptResult = await c.env.DB.prepare(
    'SELECT task_id FROM transcripts WHERE task_id = ?'
  ).bind(taskId).first()
  const minutesResult = await c.env.DB.prepare(
    'SELECT task_id FROM minutes WHERE task_id = ?'
  ).bind(taskId).first()
  const logs = await getTaskLogs(c.env, taskId, 40)
  const chunkSummary = await getChunkSummary(c.env, taskId)

  return c.json({
    task,
    hasMergedTranscript: transcriptResult !== null,
    hasMinutes: minutesResult !== null,
    logs,
    chunkSummary
  })
})

app.get('/api/tasks/:taskId/logs', async (c) => {
  const taskId = c.req.param('taskId')
  const task = await getTask(c.env, taskId)
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  const limitParam = c.req.query('limit')
  const parsedLimit = limitParam ? Number(limitParam) : NaN
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(200, Math.floor(parsedLimit)) : 40
  const logs = await getTaskLogs(c.env, taskId, limit)

  return c.json({ logs })
})

app.post('/api/tasks/:taskId/process', async (c) => {
  const taskId = c.req.param('taskId')
  const task = await getTask(c.env, taskId)
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  const reasonParam = c.req.query('reason')
  const reason = reasonParam && reasonParam.length > 0 ? reasonParam : 'manual'
  const thresholdParam = c.req.query('threshold')
  const thresholdTable = thresholdParam ? Number(thresholdParam) : NaN

  const result = await processChunkQueue(c.env, taskId)
  const summary = result.summary ?? {
    total: 0,
    queued: 0,
    processing: 0,
    completed: 0,
    error: 0
  }

  await appendTaskLog(c.env, taskId, {
    level: result.processed > 0 ? 'info' : 'warn',
    message: 'Chunk reprocess triggered',
    context: {
      reason,
      processed: result.processed,
      remaining: result.remaining,
      queued: summary.queued,
      processing: summary.processing,
      completed: summary.completed,
      error: summary.error,
      threshold: Number.isNaN(thresholdTable) ? undefined : thresholdTable
    }
  })

  if (result.processed === 0 && result.remaining > 0) {
    await appendTaskLog(c.env, taskId, {
      level: 'warn',
      message: 'Chunk queue stalled after reprocess attempt',
      context: {
        reason,
        remaining: result.remaining,
        queued: summary.queued,
        processing: summary.processing
      }
    })
  }

  return c.json({
    processed: result.processed,
    remaining: result.remaining,
    chunkSummary: summary,
    reason
  })
})

app.post('/api/tasks/:taskId/chunks', async (c) => {
  try {
    const taskId = c.req.param('taskId')
    const task = await getTask(c.env, taskId)
    if (!task) {
      return c.json({ error: 'Task not found' }, 404)
    }

  const formData = await c.req.formData().catch(() => null)
  if (!formData) {
    return c.json({ error: 'Invalid multipart/form-data payload' }, 400)
  }

  const audio = formData.get('audio')
  const chunkIndex = Number(formData.get('chunkIndex'))
  const startMs = Number(formData.get('startMs'))
  const endMs = Number(formData.get('endMs'))

  if (!(audio instanceof File)) {
    return c.json({ error: 'audio file is required' }, 400)
  }
  if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
    return c.json({ error: 'chunkIndex must be a non-negative number' }, 400)
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
    return c.json({ error: 'startMs and endMs must be valid numbers' }, 400)
  }

  const apiKey = c.env.GEMINI_API_KEY
  if (!apiKey) {
    return c.json({ error: 'Gemini API key is not configured' }, 500)
  }

  const existingChunk = await getChunk(c.env, taskId, chunkIndex)
  if (existingChunk) {
    await appendTaskLog(c.env, taskId, {
      level: 'info',
      message: 'Chunk upload skipped (already processed)',
      context: {
        chunkIndex
      }
    })
    return c.json({ chunk: existingChunk, task }, 200)
  }

  // Step 1: Save audio to R2
  const r2Key = `${taskId}/${chunkIndex}.${audio.type?.split('/')[1] || 'webm'}`
  const audioBuffer = await audio.arrayBuffer()
  
  await c.env.AUDIO_CHUNKS.put(r2Key, audioBuffer, {
    httpMetadata: {
      contentType: audio.type || 'audio/webm'
    },
    customMetadata: {
      taskId,
      chunkIndex: String(chunkIndex),
      startMs: String(startMs),
      endMs: String(endMs),
      sizeBytes: String(audio.size)
    }
  })

  // Step 2: Save metadata to D1
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO chunk_jobs 
     (task_id, chunk_index, start_ms, end_ms, mime_type, r2_key, size_bytes, attempts, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'queued', ?, ?)`
  ).bind(taskId, chunkIndex, startMs, endMs, audio.type || 'audio/webm', r2Key, audio.size, now, now).run()

  await saveChunkState(c.env, taskId, {
    index: chunkIndex,
    status: 'queued',
    attempts: 0,
    updatedAt: now
  })

  // Step 3: Send message to Queue
  await c.env.TRANSCRIPTION_QUEUE.send({
    taskId,
    chunkIndex,
    r2Key,
    startMs,
    endMs,
    mimeType: audio.type || 'audio/webm',
    sizeBytes: audio.size
  })

  await appendTaskLog(c.env, taskId, {
    level: 'info',
    message: 'Chunk queued for transcription (R2 + Queue)',
    context: {
      chunkIndex,
      r2Key,
      startMs,
      endMs,
      sizeBytes: audio.size
    }
  })

  await ensureTaskTranscribing(c.env, task)

  return c.json({ 
    message: 'Chunk accepted and queued for processing',
    chunkIndex,
    r2Key,
    queuedAt: now
  }, 202)
  } catch (error) {
    console.error('[POST /api/tasks/:taskId/chunks] Error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : undefined
    
    await appendTaskLog(c.env, c.req.param('taskId'), {
      level: 'error',
      message: 'Chunk upload failed',
      context: {
        error: errorMessage,
        stack: errorStack
      }
    }).catch(console.error)
    
    return c.json({ 
      error: 'Failed to process chunk upload',
      details: errorMessage
    }, 500)
  }
})

app.post('/api/tasks/:taskId/merge', async (c) => {
  const taskId = c.req.param('taskId')
  const task = await getTask(c.env, taskId)
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  const summary = await getChunkSummary(c.env, taskId)
  const totalChunks = task.totalChunks
  const pendingChunks = (summary.processing ?? 0) + (summary.queued ?? 0)
  const completedChunks = summary.completed ?? 0
  const summaryTotal = summary.total ?? 0

  if ((summary.error ?? 0) > 0) {
    await appendTaskLog(c.env, taskId, {
      level: 'warn',
      message: 'Transcript merge blocked: chunk errors remain',
      context: {
        summary
      }
    })
    return c.json({
      error: 'One or more chunks failed transcription. Please retry the affected chunks.',
      chunkSummary: summary
    }, 409)
  }

  if (totalChunks === 0) {
    return c.json({ error: 'No chunks available for merging' }, 400)
  }

  if (pendingChunks > 0 || completedChunks < totalChunks || summaryTotal < totalChunks) {
    await appendTaskLog(c.env, taskId, {
      level: 'info',
      message: 'Transcript merge deferred: chunks still pending',
      context: {
        summary
      }
    })
    return c.json({
      error: 'Transcription is not complete yet',
      chunkSummary: summary
    }, 409)
  }

  await appendTaskLog(c.env, taskId, {
    level: 'info',
    message: 'Transcript merge started',
    context: {
      totalChunks: task.totalChunks
    }
  })

  const chunkRecords: ChunkRecord[] = []
  for (let i = 0; i < task.totalChunks; i++) {
    const record = await getChunk(c.env, taskId, i)
    if (!record) {
      // Get existing state from DB
      const stateResult = await c.env.DB.prepare(
        'SELECT status, updated_at FROM chunk_states WHERE task_id = ? AND chunk_index = ?'
      ).bind(taskId, i).first<{ status: ChunkJobStatus, updated_at: string }>()
      
      await saveChunkState(c.env, taskId, {
        index: i,
        status: 'error',
        attempts: 0,
        updatedAt: new Date().toISOString(),
        lastError: 'Chunk missing before merge'
      })
      await appendTaskLog(c.env, taskId, {
        level: 'error',
        message: 'Transcript merge failed: chunk missing',
        context: {
          chunkIndex: i
        }
      })
      const updatedSummary = await getChunkSummary(c.env, taskId)
      return c.json({
        error: `Missing chunk ${i}. Please reprocess this chunk.`,
        chunkIndex: i,
        chunkSummary: updatedSummary
      }, 409)
    }
    chunkRecords.push(record)
  }

  const merged = mergeChunks(chunkRecords)
  const now = new Date().toISOString()
  
  // Save transcript to D1
  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO transcripts (task_id, content, created_at) VALUES (?, ?, ?)'
  ).bind(taskId, merged, now).run()

  // Update task status
  await c.env.DB.prepare(
    'UPDATE tasks SET processed_chunks = ?, status = ?, updated_at = ? WHERE id = ?'
  ).bind(totalChunks, 'transcribed', now, taskId).run()
  await appendTaskLog(c.env, taskId, {
    level: 'info',
    message: 'Transcript merge completed',
    context: {
      totalChunks: task.totalChunks
    }
  })

  return c.json({ transcript: merged })
})

app.get('/api/tasks/:taskId/transcript', async (c) => {
  const taskId = c.req.param('taskId')
  const result = await c.env.DB.prepare(
    'SELECT content FROM transcripts WHERE task_id = ?'
  ).bind(taskId).first<{ content: string }>()
  
  if (!result) {
    return c.json({ error: 'Transcript not found' }, 404)
  }
  return c.json({ transcript: result.content })
})

app.post('/api/tasks/:taskId/minutes', async (c) => {
  const taskId = c.req.param('taskId')
  const task = await getTask(c.env, taskId)
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  const transcriptResult = await c.env.DB.prepare(
    'SELECT content FROM transcripts WHERE task_id = ?'
  ).bind(taskId).first<{ content: string }>()
  
  if (!transcriptResult) {
    return c.json({ error: 'Transcript is not ready' }, 409)
  }

  const apiKey = c.env.GEMINI_API_KEY
  if (!apiKey) {
    return c.json({ error: 'Gemini API key is not configured' }, 500)
  }

  try {
    await appendTaskLog(c.env, taskId, {
      level: 'info',
      message: 'Minutes generation started',
      context: {
        filename: task.filename,
        durationMs: task.durationMs
      }
    })

    const minutesContent = await callGeminiMinutes(c.env, taskId, {
      apiKey,
      transcript: transcriptResult.content,
      filename: task.filename,
      durationMs: task.durationMs
    })

    const now = new Date().toISOString()
    
    // Save minutes to D1
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO minutes (task_id, content, created_at) VALUES (?, ?, ?)'
    ).bind(taskId, minutesContent, now).run()

    // Update task status
    await c.env.DB.prepare(
      'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?'
    ).bind('completed', now, taskId).run()
    
    await appendTaskLog(c.env, taskId, {
      level: 'info',
      message: 'Minutes generation stored',
      context: {
        minutesLength: minutesContent.length
      }
    })

    const record: MinutesRecord = {
      content: minutesContent,
      createdAt: now
    }
    return c.json({ minutes: record })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await appendTaskLog(c.env, taskId, {
      level: 'error',
      message: 'Minutes generation failed',
      context: {
        error: truncateString(message, 200)
      }
    })
    await setTaskError(c.env, taskId, message)
    return c.json({ error: message }, 500)
  }
})

app.get('/api/tasks/:taskId/minutes', async (c) => {
  const taskId = c.req.param('taskId')
  const result = await c.env.DB.prepare(
    'SELECT content, created_at FROM minutes WHERE task_id = ?'
  ).bind(taskId).first<{ content: string, created_at: string }>()
  
  if (!result) {
    return c.json({ error: 'Minutes not found' }, 404)
  }
  
  const minutes: MinutesRecord = {
    content: result.content,
    createdAt: result.created_at
  }
  return c.json(minutes)
})

app.get('/api/healthz', (c) => c.json({ ok: true }))

app.get('/api/test-api-key', (c) => {
  const apiKey = c.env.GEMINI_API_KEY
  return c.json({
    hasKey: !!apiKey,
    keyLength: apiKey?.length || 0,
    keyPrefix: apiKey ? apiKey.substring(0, 10) + '...' : 'undefined',
    keySuffix: apiKey ? '...' + apiKey.substring(apiKey.length - 4) : 'undefined'
  })
})

app.get('/api/test-r2', async (c) => {
  try {
    const testKey = 'test.txt'
    const testData = 'Hello from R2!'
    
    // Test write
    await c.env.AUDIO_CHUNKS.put(testKey, testData)
    
    // Test read
    const object = await c.env.AUDIO_CHUNKS.get(testKey)
    if (!object) {
      return c.json({ error: 'Failed to read from R2' }, 500)
    }
    
    const text = await object.text()
    
    // Test delete
    await c.env.AUDIO_CHUNKS.delete(testKey)
    
    return c.json({ 
      success: true, 
      message: 'R2 is working',
      readData: text
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : undefined
    
    return c.json({ 
      success: false,
      error: errorMessage,
      stack: errorStack
    }, 500)
  }
})

app.get('/api/tasks', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100)
  
  try {
    const results = await c.env.DB.prepare(
      'SELECT id, filename, total_chunks, processed_chunks, duration_ms, status, error, created_at, updated_at FROM tasks ORDER BY created_at DESC LIMIT ?'
    ).bind(limit).all<{
      id: string
      filename: string | null
      total_chunks: number
      processed_chunks: number
      duration_ms: number | null
      status: TaskStatus
      error: string | null
      created_at: string
      updated_at: string
    }>()
    
    if (!results.results) {
      return c.json({ tasks: [] })
    }
    
    const tasks: TaskRecord[] = results.results.map(row => ({
      id: row.id,
      filename: row.filename || undefined,
      totalChunks: row.total_chunks,
      processedChunks: row.processed_chunks,
      durationMs: row.duration_ms || undefined,
      status: row.status,
      error: row.error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
    
    return c.json({ tasks })
  } catch (error) {
    console.error('Failed to fetch tasks:', error)
    return c.json({ error: 'Failed to fetch tasks' }, 500)
  }
})

// Queue Consumer handler (separate from Hono app)
async function queueHandler(batch: MessageBatch<ChunkJobMessage>, env: Bindings): Promise<void> {
  console.log(`[Queue Consumer] Processing ${batch.messages.length} messages`)
  
  for (const message of batch.messages) {
    const { taskId, chunkIndex, r2Key, startMs, endMs, mimeType, sizeBytes } = message.body
    
    try {
      console.log(`[Queue Consumer] Processing chunk ${chunkIndex} for task ${taskId}`)
      
      // Step 1: Update status to 'processing'
      const now = new Date().toISOString()
      const workerId = crypto.randomUUID()
      
      await env.DB.prepare(
        `UPDATE chunk_jobs SET status = 'processing', processing_by = ?, updated_at = ? 
         WHERE task_id = ? AND chunk_index = ?`
      ).bind(workerId, now, taskId, chunkIndex).run()
      
      await saveChunkState(env, taskId, {
        index: chunkIndex,
        status: 'processing',
        attempts: 0, // Will be incremented on retry
        updatedAt: now
      })
      
      // Step 2: Get audio from R2
      const r2Object = await env.AUDIO_CHUNKS.get(r2Key)
      if (!r2Object) {
        throw new Error(`R2 object not found: ${r2Key}`)
      }
      
      const audioBuffer = await r2Object.arrayBuffer()
      const base64Audio = arrayBufferToBase64(audioBuffer)
      
      // Step 3: Call Gemini API
      const apiKey = env.GEMINI_API_KEY
      if (!apiKey) {
        throw new Error('Gemini API key is not configured')
      }
      
      const transcriptText = await callGeminiFlashTranscription(
        apiKey,
        base64Audio,
        mimeType,
        chunkIndex
      )
      
      // Step 4: Save result to D1
      const completedAt = new Date().toISOString()
      
      // Save to chunks table
      await env.DB.prepare(
        `INSERT OR REPLACE INTO chunks 
         (task_id, chunk_index, start_ms, end_ms, transcript_text, size_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(taskId, chunkIndex, startMs, endMs, transcriptText, sizeBytes, completedAt, completedAt).run()
      
      // Update chunk_jobs status
      await env.DB.prepare(
        `DELETE FROM chunk_jobs WHERE task_id = ? AND chunk_index = ?`
      ).bind(taskId, chunkIndex).run()
      
      // Update chunk_states
      await saveChunkState(env, taskId, {
        index: chunkIndex,
        status: 'completed',
        attempts: 0,
        updatedAt: completedAt
      })
      
      // Step 5: Delete from R2 (cleanup)
      await env.AUDIO_CHUNKS.delete(r2Key)
      
      // Step 6: Log success
      await appendTaskLog(env, taskId, {
        level: 'info',
        message: 'Chunk transcription completed',
        context: {
          chunkIndex,
          transcriptLength: transcriptText.length,
          processingTime: Date.now() - new Date(now).getTime()
        }
      })
      
      console.log(`[Queue Consumer] Chunk ${chunkIndex} completed for task ${taskId}`)
      
      // Acknowledge successful processing
      message.ack()
      
    } catch (error) {
      console.error(`[Queue Consumer] Error processing chunk ${chunkIndex}:`, error)
      
      // Update error in D1
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorNow = new Date().toISOString()
      
      await env.DB.prepare(
        `UPDATE chunk_jobs SET status = 'queued', processing_by = NULL, last_error = ?, updated_at = ?, attempts = attempts + 1
         WHERE task_id = ? AND chunk_index = ?`
      ).bind(errorMessage, errorNow, taskId, chunkIndex).run()
      
      await appendTaskLog(env, taskId, {
        level: 'error',
        message: 'Chunk transcription failed',
        context: {
          chunkIndex,
          error: errorMessage
        }
      })
      
      // Retry the message (Cloudflare will handle exponential backoff)
      message.retry()
    }
  }
}

// Export Workers handlers
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx)
  },
  async queue(batch: MessageBatch<ChunkJobMessage>, env: Bindings) {
    return queueHandler(batch, env)
  }
}

// Queue consumer for background transcription processing
export async function queue(batch: MessageBatch<ChunkJobMessage>, env: Bindings): Promise<void> {
  const config = getRuntimeConfig(env)
  
  for (const message of batch.messages) {
    const { taskId, chunkIndex } = message.body
    
    try {
      // Get the queued job from D1
      const job = await env.DB.prepare(
        `SELECT chunk_index, start_ms, end_ms, mime_type, audio_base64, size_bytes, attempts, status, 
                last_error, processing_by, retry_at, created_at, updated_at
         FROM chunk_jobs 
         WHERE task_id = ? AND chunk_index = ? AND status = 'queued'`
      ).bind(taskId, chunkIndex).first<{
        chunk_index: number
        start_ms: number
        end_ms: number
        mime_type: string
        audio_base64: string
        size_bytes: number
        attempts: number
        status: ChunkJobStatus
        last_error: string | null
        processing_by: string | null
        retry_at: string | null
        created_at: string
        updated_at: string
      }>()
      
      if (!job) {
        console.log(`Job not found or already processed: task=${taskId} chunk=${chunkIndex}`)
        message.ack()
        continue
      }
      
      const jobRecord: ChunkJobRecord = {
        index: job.chunk_index,
        startMs: job.start_ms,
        endMs: job.end_ms,
        mimeType: job.mime_type,
        audioBase64: job.audio_base64,
        sizeBytes: job.size_bytes,
        attempts: job.attempts,
        status: job.status,
        lastError: job.last_error || undefined,
        processingBy: job.processing_by || undefined,
        retryAt: job.retry_at || undefined,
        createdAt: job.created_at,
        updatedAt: job.updated_at
      }
      
      // Process the chunk
      const success = await processChunkJob(env, taskId, jobRecord, config)
      
      if (success) {
        console.log(`Successfully processed: task=${taskId} chunk=${chunkIndex}`)
        message.ack()
      } else {
        console.log(`Failed to process: task=${taskId} chunk=${chunkIndex}`)
        message.retry()
      }
    } catch (error) {
      console.error(`Queue processing error: task=${taskId} chunk=${chunkIndex}`, error)
      message.retry()
    }
  }
}

function getRuntimeConfig(env: Bindings): RuntimeConfig {
  const chunkSizeBytes = clampNumber(parseInteger(env.CHUNK_SIZE_BYTES, DEFAULT_CHUNK_SIZE_BYTES), 128 * 1024, 8 * 1024 * 1024)
  const overlapSeconds = clampNumber(parseInteger(env.CHUNK_OVERLAP_SECONDS, DEFAULT_CHUNK_OVERLAP_SECONDS), 0, 30)
  const transcriptionConcurrency = clampNumber(
    parseInteger(env.TRANSCRIPTION_MAX_CONCURRENCY, DEFAULT_TRANSCRIPTION_CONCURRENCY),
    1,
    MAX_CONCURRENCY_LIMIT
  )
  const chunkJobMaxAttempts = clampNumber(
    parseInteger(env.CHUNK_JOB_MAX_ATTEMPTS, DEFAULT_CHUNK_JOB_MAX_ATTEMPTS),
    1,
    MAX_CHUNK_JOB_ATTEMPTS_LIMIT
  )
  const uploadConcurrency = clampNumber(parseInteger(env.UPLOAD_CONCURRENCY, DEFAULT_UPLOAD_CONCURRENCY), 1, MAX_CONCURRENCY_LIMIT)

  return {
    chunkSizeBytes,
    overlapSeconds,
    transcriptionConcurrency,
    chunkJobMaxAttempts,
    uploadConcurrency
  }
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return parsed
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function sanitizeChunkJobForResponse(job: ChunkJobRecord) {
  const { audioBase64, processingBy, ...rest } = job
  return rest
}

async function enqueueChunkJob(env: Bindings, taskId: string, input: EnqueueChunkJobInput): Promise<ChunkJobRecord> {
  const now = new Date().toISOString()
  
  // Check if job already exists
  const existing = await env.DB.prepare(
    'SELECT attempts, created_at FROM chunk_jobs WHERE task_id = ? AND chunk_index = ?'
  ).bind(taskId, input.index).first<{ attempts: number, created_at: string }>()
  
  const attempts = existing?.attempts ?? 0
  const createdAt = existing?.created_at ?? now
  
  // Insert or replace
  await env.DB.prepare(
    `INSERT OR REPLACE INTO chunk_jobs 
     (task_id, chunk_index, start_ms, end_ms, mime_type, audio_base64, size_bytes, attempts, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
  ).bind(taskId, input.index, input.startMs, input.endMs, input.mimeType, input.audioBase64, input.sizeBytes, attempts, createdAt, now).run()
  
  // Save chunk state
  await saveChunkState(env, taskId, {
    index: input.index,
    status: 'queued',
    attempts: attempts,
    updatedAt: now
  })
  
  const job: ChunkJobRecord = {
    index: input.index,
    startMs: input.startMs,
    endMs: input.endMs,
    mimeType: input.mimeType,
    audioBase64: input.audioBase64,
    sizeBytes: input.sizeBytes,
    attempts: attempts,
    status: 'queued',
    createdAt: createdAt,
    updatedAt: now,
    lastError: undefined,
    processingBy: undefined,
    retryAt: undefined
  }
  
  return job
}

async function ensureTaskTranscribing(env: Bindings, task: TaskRecord): Promise<TaskRecord> {
  if (task.status === 'initialized') {
    const now = new Date().toISOString()
    await env.DB.prepare(
      'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?'
    ).bind('transcribing', now, task.id).run()
    return {
      ...task,
      status: 'transcribing',
      updatedAt: now
    }
  }
  return task
}

async function processChunkQueue(env: Bindings, taskId: string, options: ProcessQueueOptions = {}) {
  const { maxIterations = 50 } = options
  const config = getRuntimeConfig(env)
  const concurrency = Math.max(1, config.transcriptionConcurrency)
  const batchLimit = Math.max(concurrency * CHUNK_QUEUE_BATCH_MULTIPLIER, concurrency)
  let processed = 0

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const jobs = await getQueuedChunkJobs(env, taskId, concurrency, batchLimit)
    if (jobs.length === 0) {
      break
    }

    const results = await Promise.all(
      jobs.map((job) =>
        processChunkJob(env, taskId, job, config)
          .then((success) => (success ? 1 : 0))
          .catch((error) => {
            console.error('processChunkJob error', error)
            return 0
          })
      )
    )

    processed += results.reduce((sum, value) => sum + value, 0)
    if (jobs.length < concurrency) {
      break
    }
  }

  const summary = await getChunkSummary(env, taskId)
  return {
    processed,
    remaining: summary.queued,
    summary
  }
}

async function getQueuedChunkJobs(
  env: Bindings,
  taskId: string,
  limit: number,
  batchLimit: number
): Promise<ChunkJobRecord[]> {
  const now = Date.now()
  const STUCK_JOB_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes
  
  // First, detect and reset stuck processing jobs (updated_at > 2 minutes ago)
  const stuckThreshold = new Date(now - STUCK_JOB_TIMEOUT_MS).toISOString()
  const stuckReset = await env.DB.prepare(
    `UPDATE chunk_jobs 
     SET status = 'queued', processing_by = NULL, updated_at = ?
     WHERE task_id = ? AND status = 'processing' AND updated_at < ?`
  ).bind(new Date(now).toISOString(), taskId, stuckThreshold).run()
  
  if (stuckReset.meta.changes > 0) {
    console.log(`Reset ${stuckReset.meta.changes} stuck processing jobs for task ${taskId}`)
  }
  
  // Also update chunk_states for reset jobs
  if (stuckReset.meta.changes > 0) {
    await env.DB.prepare(
      `UPDATE chunk_states 
       SET status = 'queued', updated_at = ?
       WHERE task_id = ? AND status = 'processing'`
    ).bind(new Date(now).toISOString(), taskId).run()
  }
  
  // CRITICAL: Check how many jobs are currently processing
  // If we're at the concurrency limit, return empty array to prevent overload
  const processingCount = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM chunk_jobs WHERE task_id = ? AND status = 'processing'`
  ).bind(taskId).first<{ count: number }>()
  
  const currentlyProcessing = processingCount?.count || 0
  if (currentlyProcessing >= limit) {
    // Already at concurrency limit, don't fetch more jobs
    console.log(`Concurrency limit reached: ${currentlyProcessing}/${limit} jobs processing for task ${taskId}`)
    return []
  }
  
  // Calculate how many jobs we can actually process
  const availableSlots = limit - currentlyProcessing
  const effectiveLimit = Math.min(availableSlots, limit)
  
  const results = await env.DB.prepare(
    `SELECT chunk_index, start_ms, end_ms, mime_type, audio_base64, size_bytes, attempts, status, 
            last_error, processing_by, retry_at, created_at, updated_at
     FROM chunk_jobs 
     WHERE task_id = ? AND status = 'queued' AND (retry_at IS NULL OR retry_at <= ?)
     ORDER BY chunk_index
     LIMIT ?`
  ).bind(taskId, new Date(now).toISOString(), effectiveLimit).all<{
    chunk_index: number
    start_ms: number
    end_ms: number
    mime_type: string
    audio_base64: string
    size_bytes: number
    attempts: number
    status: ChunkJobStatus
    last_error: string | null
    processing_by: string | null
    retry_at: string | null
    created_at: string
    updated_at: string
  }>()
  
  if (!results.results) return []
  
  return results.results.map(row => ({
    index: row.chunk_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    mimeType: row.mime_type,
    audioBase64: row.audio_base64,
    sizeBytes: row.size_bytes,
    attempts: row.attempts,
    status: row.status,
    lastError: row.last_error || undefined,
    processingBy: row.processing_by || undefined,
    retryAt: row.retry_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

async function claimChunkJob(env: Bindings, taskId: string, index: number, workerId: string): Promise<ChunkJobRecord | null> {
  const now = new Date().toISOString()
  const nowMs = Date.now()
  
  // Check if job is available
  const job = await env.DB.prepare(
    `SELECT chunk_index, start_ms, end_ms, mime_type, audio_base64, size_bytes, attempts, status,
            last_error, processing_by, retry_at, created_at, updated_at
     FROM chunk_jobs
     WHERE task_id = ? AND chunk_index = ? AND status = 'queued'`
  ).bind(taskId, index).first<{
    chunk_index: number
    start_ms: number
    end_ms: number
    mime_type: string
    audio_base64: string
    size_bytes: number
    attempts: number
    status: ChunkJobStatus
    last_error: string | null
    processing_by: string | null
    retry_at: string | null
    created_at: string
    updated_at: string
  }>()
  
  if (!job) return null
  if (job.retry_at && Date.parse(job.retry_at) > nowMs) return null
  
  // Claim the job
  await env.DB.prepare(
    'UPDATE chunk_jobs SET status = ?, processing_by = ?, updated_at = ? WHERE task_id = ? AND chunk_index = ? AND status = \'queued\''
  ).bind('processing', workerId, now, taskId, index).run()
  
  // Verify claim
  const confirmed = await env.DB.prepare(
    `SELECT chunk_index, start_ms, end_ms, mime_type, audio_base64, size_bytes, attempts, status,
            last_error, processing_by, retry_at, created_at, updated_at
     FROM chunk_jobs
     WHERE task_id = ? AND chunk_index = ?`
  ).bind(taskId, index).first<{
    chunk_index: number
    start_ms: number
    end_ms: number
    mime_type: string
    audio_base64: string
    size_bytes: number
    attempts: number
    status: ChunkJobStatus
    last_error: string | null
    processing_by: string | null
    retry_at: string | null
    created_at: string
    updated_at: string
  }>()
  
  if (!confirmed || confirmed.processing_by !== workerId || confirmed.status !== 'processing') {
    return null
  }
  
  return {
    index: confirmed.chunk_index,
    startMs: confirmed.start_ms,
    endMs: confirmed.end_ms,
    mimeType: confirmed.mime_type,
    audioBase64: confirmed.audio_base64,
    sizeBytes: confirmed.size_bytes,
    attempts: confirmed.attempts,
    status: confirmed.status,
    lastError: confirmed.last_error || undefined,
    processingBy: confirmed.processing_by || undefined,
    retryAt: confirmed.retry_at || undefined,
    createdAt: confirmed.created_at,
    updatedAt: confirmed.updated_at
  }
}

async function processChunkJob(
  env: Bindings,
  taskId: string,
  job: ChunkJobRecord,
  config: RuntimeConfig
): Promise<boolean> {
  const workerId = crypto.randomUUID()
  const claimed = await claimChunkJob(env, taskId, job.index, workerId)
  if (!claimed) {
    return false
  }

  const attemptNumber = claimed.attempts + 1
  const startedAt = Date.now()

  await saveChunkState(env, taskId, {
    index: claimed.index,
    status: 'processing',
    attempts: attemptNumber,
    updatedAt: new Date().toISOString(),
    lastError: claimed.lastError
  })

  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) {
    await handleChunkJobFailure(
      env,
      taskId,
      claimed,
      attemptNumber,
      'Gemini API key is not configured',
      config,
      false
    )
    return false
  }

  const previousChunk = claimed.index > 0 ? await getChunk(env, taskId, claimed.index - 1) : null
  const previousContext = previousChunk ? previousChunk.text.slice(-1500) : ''

  await appendTaskLog(env, taskId, {
    level: 'info',
    message: 'Chunk transcription started',
    context: {
      chunkIndex: claimed.index,
      attempt: attemptNumber
    }
  })

  try {
    const transcription = await callGeminiFlashTranscription(env, taskId, {
      apiKey,
      audioBase64: claimed.audioBase64,
      mimeType: claimed.mimeType,
      chunkIndex: claimed.index,
      chunkStartMs: claimed.startMs,
      chunkEndMs: claimed.endMs,
      previousContext
    })

    const nowIso = new Date().toISOString()
    const chunkRecord: ChunkRecord = {
      index: claimed.index,
      startMs: claimed.startMs,
      endMs: claimed.endMs,
      text: transcription,
      createdAt: nowIso
    }

    // Save chunk to D1
    await env.DB.prepare(
      'INSERT INTO chunks (task_id, chunk_index, start_ms, end_ms, text, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(taskId, claimed.index, claimed.startMs, claimed.endMs, transcription, nowIso).run()
    
    // Delete job
    await env.DB.prepare(
      'DELETE FROM chunk_jobs WHERE task_id = ? AND chunk_index = ?'
    ).bind(taskId, claimed.index).run()

    await saveChunkState(env, taskId, {
      index: claimed.index,
      status: 'completed',
      attempts: attemptNumber,
      updatedAt: nowIso
    })

    await appendTaskLog(env, taskId, {
      level: 'info',
      message: 'Chunk transcription stored',
      context: {
        chunkIndex: claimed.index,
        attempts: attemptNumber,
        textLength: transcription.length,
        durationMs: Date.now() - startedAt
      }
    })

    await updateTaskProgress(env, taskId)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await handleChunkJobFailure(env, taskId, claimed, attemptNumber, message, config, true)
    return false
  }
}

async function handleChunkJobFailure(
  env: Bindings,
  taskId: string,
  job: ChunkJobRecord,
  attemptNumber: number,
  message: string,
  config: RuntimeConfig,
  allowRetry: boolean
) {
  const nowIso = new Date().toISOString()
  const retryable = allowRetry && attemptNumber < config.chunkJobMaxAttempts
  const nextStatus: ChunkJobStatus = retryable ? 'queued' : 'error'
  const retryDelayMs = retryable ? getBackoffDelay(attemptNumber) : 0
  const retryAt = retryable ? new Date(Date.now() + retryDelayMs).toISOString() : null
  const errorMessage = truncateString(message, 200)

  // Update job in D1
  await env.DB.prepare(
    'UPDATE chunk_jobs SET attempts = ?, status = ?, last_error = ?, processing_by = NULL, retry_at = ?, updated_at = ? WHERE task_id = ? AND chunk_index = ?'
  ).bind(attemptNumber, nextStatus, errorMessage, retryAt, nowIso, taskId, job.index).run()
  
  await saveChunkState(env, taskId, {
    index: job.index,
    status: nextStatus,
    attempts: attemptNumber,
    updatedAt: nowIso,
    lastError: errorMessage
  })

  if (retryable) {
    await appendTaskLog(env, taskId, {
      level: 'warn',
      message: 'Chunk transcription re-queued',
      context: {
        chunkIndex: job.index,
        attempt: attemptNumber,
        error: truncateString(message, 200),
        retryDelayMs
      }
    })
  } else {
    await appendTaskLog(env, taskId, {
      level: 'error',
      message: 'Chunk transcription failed',
      context: {
        chunkIndex: job.index,
        attempts: attemptNumber,
        error: truncateString(message, 200)
      }
    })
    await setTaskError(env, taskId, message)
  }
}

async function saveChunkState(
  env: Bindings,
  taskId: string,
  state: ChunkStateRecord
): Promise<void> {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO chunk_states (task_id, chunk_index, status, last_error, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(taskId, state.index, state.status, state.lastError || null, state.updatedAt).run()
}

async function getChunkSummary(env: Bindings, taskId: string): Promise<ChunkSummary> {
  const records = await getChunkStateRecords(env, taskId)
  const summary: ChunkSummary = {
    total: records.length,
    queued: 0,
    processing: 0,
    completed: 0,
    error: 0
  }

  for (const record of records) {
    switch (record.status) {
      case 'queued':
        summary.queued += 1
        break
      case 'processing':
        summary.processing += 1
        break
      case 'completed':
        summary.completed += 1
        break
      case 'error':
        summary.error += 1
        break
    }
  }

  return summary
}

async function getChunkStateRecords(env: Bindings, taskId: string): Promise<ChunkStateRecord[]> {
  const results = await env.DB.prepare(
    'SELECT chunk_index, status, last_error, updated_at FROM chunk_states WHERE task_id = ? ORDER BY chunk_index'
  ).bind(taskId).all<{
    chunk_index: number
    status: ChunkJobStatus
    last_error: string | null
    updated_at: string
  }>()
  
  if (!results.results) return []
  
  return results.results.map(row => ({
    index: row.chunk_index,
    status: row.status,
    lastError: row.last_error || undefined,
    updatedAt: row.updated_at,
    attempts: 0 // Not stored in chunk_states table
  }))
}

async function updateTaskProgress(env: Bindings, taskId: string): Promise<TaskRecord | null> {
  const task = await getTask(env, taskId)
  if (!task) return null

  const summary = await getChunkSummary(env, taskId)
  const processedChunks = summary.completed
  const nowIso = new Date().toISOString()

  if (task.status === 'error') {
    await env.DB.prepare(
      'UPDATE tasks SET processed_chunks = ?, updated_at = ? WHERE id = ?'
    ).bind(processedChunks, nowIso, taskId).run()
    return {
      ...task,
      processedChunks,
      updatedAt: nowIso
    }
  }

  let status: TaskStatus = task.status
  if (processedChunks >= task.totalChunks && task.totalChunks > 0) {
    status = 'transcribed'
  } else if (processedChunks > 0 && status === 'initialized') {
    status = 'transcribing'
  } else if (processedChunks > 0 && status !== 'completed') {
    status = 'transcribing'
  }

  await env.DB.prepare(
    'UPDATE tasks SET processed_chunks = ?, status = ?, updated_at = ? WHERE id = ?'
  ).bind(processedChunks, status, nowIso, taskId).run()
  
  return {
    ...task,
    processedChunks,
    status,
    updatedAt: nowIso
  }
}

async function getTask(env: Bindings, taskId: string): Promise<TaskRecord | null> {
  const result = await env.DB.prepare(
    'SELECT id, filename, total_chunks, processed_chunks, duration_ms, status, error, created_at, updated_at FROM tasks WHERE id = ?'
  ).bind(taskId).first<{
    id: string
    filename: string | null
    total_chunks: number
    processed_chunks: number
    duration_ms: number | null
    status: TaskStatus
    error: string | null
    created_at: string
    updated_at: string
  }>()
  
  if (!result) return null
  
  return {
    id: result.id,
    filename: result.filename || undefined,
    totalChunks: result.total_chunks,
    processedChunks: result.processed_chunks,
    durationMs: result.duration_ms || undefined,
    status: result.status,
    error: result.error || undefined,
    createdAt: result.created_at,
    updatedAt: result.updated_at
  }
}

async function getChunk(env: Bindings, taskId: string, index: number): Promise<ChunkRecord | null> {
  const result = await env.DB.prepare(
    'SELECT chunk_index, start_ms, end_ms, text, raw_response, created_at FROM chunks WHERE task_id = ? AND chunk_index = ?'
  ).bind(taskId, index).first<{
    chunk_index: number
    start_ms: number
    end_ms: number
    text: string
    raw_response: string | null
    created_at: string
  }>()
  
  if (!result) return null
  
  return {
    index: result.chunk_index,
    startMs: result.start_ms,
    endMs: result.end_ms,
    text: result.text,
    rawResponse: result.raw_response ? JSON.parse(result.raw_response) : undefined,
    createdAt: result.created_at
  }
}

async function setTaskError(env: Bindings, taskId: string, message: string) {
  const task = await getTask(env, taskId)
  if (!task) return
  const now = new Date().toISOString()
  await env.DB.prepare(
    'UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?'
  ).bind('error', message, now, taskId).run()
  
  await appendTaskLog(env, taskId, {
    level: 'error',
    message: 'Task marked as error',
    context: {
      error: truncateString(message, 200)
    }
  })
}

async function appendTaskLog(env: Bindings, taskId: string, entry: TaskLogInput) {
  try {
    const timestamp = entry.timestamp ?? new Date().toISOString()
    const context = sanitizeLogContext(entry.context)
    const contextJson = context ? JSON.stringify(context) : null
    
    await env.DB.prepare(
      'INSERT INTO task_logs (task_id, timestamp, level, message, context) VALUES (?, ?, ?, ?, ?)'
    ).bind(taskId, timestamp, entry.level, entry.message, contextJson).run()
  } catch (error) {
    console.error('appendTaskLog failed', error)
  }
}

async function getTaskLogs(env: Bindings, taskId: string, limit = 40): Promise<TaskLogEntry[]> {
  const results = await env.DB.prepare(
    'SELECT timestamp, level, message, context FROM task_logs WHERE task_id = ? ORDER BY timestamp DESC LIMIT ?'
  ).bind(taskId, limit).all<{
    timestamp: string
    level: TaskLogLevel
    message: string
    context: string | null
  }>()
  
  if (!results.results) return []
  
  return results.results.reverse().map(row => ({
    timestamp: row.timestamp,
    level: row.level,
    message: row.message,
    context: row.context ? JSON.parse(row.context) : undefined
  }))
}

function sanitizeLogContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) return undefined
  const entries = Object.entries(context).slice(0, 12)
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    if (value === undefined) continue
    if (typeof value === 'string') {
      sanitized[key] = truncateString(value, 180)
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      sanitized[key] = value
    } else {
      sanitized[key] = truncateString(JSON.stringify(value), 180)
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

function truncateString(value: string, max = 300): string {
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function isRetryableStatus(status: number): boolean {
  return GEMINI_RETRYABLE_STATUS_CODES.has(status)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function getBackoffDelay(attempt: number): number {
  const jitter = Math.floor(Math.random() * 400)
  return GEMINI_BACKOFF_BASE_MS * 2 ** (attempt - 1) + jitter
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function parseGeminiErrorResponse(response: Response): Promise<{
  message: string
  status?: string
  code?: number
}> {
  const text = await readResponseTextSafe(response)
  try {
    const parsed = JSON.parse(text) as {
      error?: {
        message?: string
        status?: string
        code?: number
      }
    }
    if (parsed?.error) {
      return {
        message: parsed.error.message ?? text,
        status: parsed.error.status,
        code: parsed.error.code
      }
    }
    return { message: text }
  } catch {
    return { message: text }
  }
}

async function readResponseTextSafe(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch (error) {
    console.warn('Failed to read response text', error)
    return ''
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const subArray = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...subArray)
  }
  return btoa(binary)
}

async function callGeminiFlashTranscription(
  env: Bindings,
  taskId: string,
  params: {
    apiKey: string
    audioBase64: string
    mimeType: string
    chunkIndex: number
    chunkStartMs: number
    chunkEndMs: number
    previousContext?: string
  }
): Promise<string> {
  const {
    apiKey,
    audioBase64,
    mimeType,
    chunkIndex,
    chunkStartMs,
    chunkEndMs,
    previousContext = ''
  } = params

  const systemInstruction = {
    role: 'system',
    parts: [
      {
        text: [
          'You are a professional transcription assistant for Japanese tax accountant meetings.',
          'Always respond using the original language of the speakers.',
          'Output each utterance on its own line in the format "HH:MM:SS Speaker Name: transcript".',
          'If the meeting does not exceed one hour you may omit the hour portion and use MM:SS.',
          'Use absolute timestamps measured from the start of the meeting. The chunk start time is provided; add it to timestamps.',
          'Do not include duplicate lines or repeated text.'
        ].join('\n')
      }
    ]
  }

  const contextText = previousContext
    ? `Previous context (do not repeat, only use for continuity):\n${previousContext}\n`
    : 'No previous context.'

  const userParts = [
    {
      text: [
        `Chunk metadata:`,
        `- Index: ${chunkIndex}`,
        `- Start offset (ms): ${chunkStartMs}`,
        `- End offset (ms): ${chunkEndMs}`,
        '',
        contextText,
        'Transcribe the attached audio chunk and include timestamps as described.'
      ].join('\n')
    },
    {
      inline_data: {
        mime_type: mimeType,
        data: audioBase64
      }
    }
  ]

  const requestBody = JSON.stringify({
    system_instruction: systemInstruction,
    contents: [
      {
        role: 'user',
        parts: userParts
      }
    ]
  })

  const url = `${GEMINI_API_BASE}/v1beta/models/${GEMINI_FLASH_MODEL}:generateContent?key=${apiKey}`
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= GEMINI_FLASH_MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_FLASH_TIMEOUT_MS)

    try {
      await appendTaskLog(env, taskId, {
        level: 'info',
        message: 'Gemini Flash transcription request',
        context: {
          chunkIndex,
          attempt
        }
      })

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: requestBody,
        signal: controller.signal
      })

      if (response.ok) {
        const data = (await response.json()) as GeminiGenerateContentResponse
        const text = extractCandidateText(data)
        if (!text) {
          throw new Error('Gemini Flash returned no transcription text')
        }
        const trimmed = text.trim()
        await appendTaskLog(env, taskId, {
          level: 'info',
          message: 'Gemini Flash transcription success',
          context: {
            chunkIndex,
            attempt,
            textLength: trimmed.length
          }
        })
        return trimmed
      }

      const errorDetails = await parseGeminiErrorResponse(response)
      const retryable = isRetryableStatus(response.status)
      const context = {
        chunkIndex,
        attempt,
        status: response.status,
        errorStatus: errorDetails.status,
        errorCode: errorDetails.code,
        errorMessage: truncateString(errorDetails.message, 200)
      }

      if (!retryable || attempt === GEMINI_FLASH_MAX_RETRIES) {
        await appendTaskLog(env, taskId, {
          level: 'error',
          message: 'Gemini Flash transcription failed',
          context
        })
        throw new Error(`Gemini Flash API error: ${response.status} ${errorDetails.message}`)
      }

      await appendTaskLog(env, taskId, {
        level: 'warn',
        message: 'Gemini Flash transcription retry scheduled',
        context
      })
      lastError = new Error(`Gemini Flash API error: ${response.status} ${errorDetails.message}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const retryable =
        isAbortError(error) ||
        error instanceof TypeError ||
        /timeout/i.test(errorMessage)

      if (!retryable || attempt === GEMINI_FLASH_MAX_RETRIES) {
        await appendTaskLog(env, taskId, {
          level: 'error',
          message: 'Gemini Flash transcription exception',
          context: {
            chunkIndex,
            attempt,
            error: truncateString(errorMessage, 200)
          }
        })
        throw new Error(`Gemini Flash API error: ${errorMessage}`)
      }

      await appendTaskLog(env, taskId, {
        level: 'warn',
        message: 'Gemini Flash transcription transient exception',
        context: {
          chunkIndex,
          attempt,
          error: truncateString(errorMessage, 200)
        }
      })
      lastError = error instanceof Error ? error : new Error(errorMessage)
    } finally {
      clearTimeout(timeoutId)
    }

    if (attempt < GEMINI_FLASH_MAX_RETRIES) {
      await sleep(getBackoffDelay(attempt))
    }
  }

  throw lastError ?? new Error('Gemini Flash API error: Unknown failure')
}

async function callGeminiMinutes(
  env: Bindings,
  taskId: string,
  params: {
    apiKey: string
    transcript: string
    filename?: string
    durationMs?: number
  }
): Promise<string> {
  const { apiKey, transcript, filename, durationMs } = params
  const meetingLengthMinutes = durationMs ? Math.round(durationMs / 60000) : undefined

  const systemInstruction = {
    role: 'system',
    parts: [
      {
        text: [
          'You are an assistant that creates structured meeting minutes for Japanese tax accountant offices.',
          'Summaries must be precise, concise, and action-oriented.',
          'Respond in Japanese unless the transcript is clearly in another language.',
          'Always include the following sections:',
          '1. 概要',
          '2. 決定事項 (with bullet list)',
          '3. TODO (table with 担当者 and 期限 if available, otherwise note 未設定)',
          '4. 懸念点・リスク',
          '5. 次回までのフォローアップ',
          '6. 重要タイムライン (key timestamps referencing the transcript times)'
        ].join('\n')
      }
    ]
  }

  const userTextLines = [
    filename ? `議事録タイトル候補: ${filename}` : undefined,
    meetingLengthMinutes ? `会議の想定長さ: 約${meetingLengthMinutes}分` : undefined,
    '以下がタイムスタンプ付き全文です。これを基に議事録を作成してください。',
    '---',
    transcript
  ].filter(Boolean) as string[]

  const requestBody = JSON.stringify({
    system_instruction: systemInstruction,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: userTextLines.join('\n')
          }
        ]
      }
    ]
  })

  const url = `${GEMINI_API_BASE}/v1beta/models/${GEMINI_PRO_MODEL}:generateContent?key=${apiKey}`
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= GEMINI_PRO_MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_PRO_TIMEOUT_MS)

    try {
      await appendTaskLog(env, taskId, {
        level: 'info',
        message: 'Gemini Pro minutes request',
        context: {
          attempt,
          filename,
          meetingLengthMinutes
        }
      })

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: requestBody,
        signal: controller.signal
      })

      if (response.ok) {
        const data = (await response.json()) as GeminiGenerateContentResponse
        const text = extractCandidateText(data)
        if (!text) {
          throw new Error('Gemini Pro returned no minutes text')
        }
        const trimmed = text.trim()
        await appendTaskLog(env, taskId, {
          level: 'info',
          message: 'Gemini Pro minutes success',
          context: {
            attempt,
            minutesLength: trimmed.length
          }
        })
        return trimmed
      }

      const errorDetails = await parseGeminiErrorResponse(response)
      const retryable = isRetryableStatus(response.status)
      const context = {
        attempt,
        status: response.status,
        errorStatus: errorDetails.status,
        errorCode: errorDetails.code,
        errorMessage: truncateString(errorDetails.message, 200)
      }

      if (!retryable || attempt === GEMINI_PRO_MAX_RETRIES) {
        await appendTaskLog(env, taskId, {
          level: 'error',
          message: 'Gemini Pro minutes failed',
          context
        })
        throw new Error(`Gemini Pro API error: ${response.status} ${errorDetails.message}`)
      }

      await appendTaskLog(env, taskId, {
        level: 'warn',
        message: 'Gemini Pro minutes retry scheduled',
        context
      })
      lastError = new Error(`Gemini Pro API error: ${response.status} ${errorDetails.message}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const retryable =
        isAbortError(error) ||
        error instanceof TypeError ||
        /timeout/i.test(errorMessage)

      if (!retryable || attempt === GEMINI_PRO_MAX_RETRIES) {
        await appendTaskLog(env, taskId, {
          level: 'error',
          message: 'Gemini Pro minutes exception',
          context: {
            attempt,
            error: truncateString(errorMessage, 200)
          }
        })
        throw new Error(`Gemini Pro API error: ${errorMessage}`)
      }

      await appendTaskLog(env, taskId, {
        level: 'warn',
        message: 'Gemini Pro minutes transient exception',
        context: {
          attempt,
          error: truncateString(errorMessage, 200)
        }
      })
      lastError = error instanceof Error ? error : new Error(errorMessage)
    } finally {
      clearTimeout(timeoutId)
    }

    if (attempt < GEMINI_PRO_MAX_RETRIES) {
      await sleep(getBackoffDelay(attempt))
    }
  }

  throw lastError ?? new Error('Gemini Pro API error: Unknown failure')
}

function mergeChunks(chunks: ChunkRecord[]): string {
  const sorted = [...chunks].sort((a, b) => a.index - b.index)
  let thresholdMs = 0
  const lines: string[] = []

  for (const chunk of sorted) {
    const chunkLines = chunk.text.split(/\r?\n/)
    for (const line of chunkLines) {
      const timestampMs = getTimestampMs(line)
      if (timestampMs !== null) {
        if (timestampMs + 1 < thresholdMs) {
          continue
        }
        thresholdMs = Math.max(thresholdMs, timestampMs)
        lines.push(line.trimEnd())
      } else {
        if (lines.length > 0) {
          lines[lines.length - 1] = `${lines[lines.length - 1]}\n${line}`
        } else {
          lines.push(line)
        }
      }
    }
    thresholdMs = Math.max(thresholdMs, chunk.endMs)
  }

  return lines.join('\n')
}

function getTimestampMs(line: string): number | null {
  const match = line.match(TIMESTAMP_PATTERN)
  if (!match) return null
  const [, , hhOrMm, mm, ss] = match
  if (ss) {
    const hours = Number(hhOrMm)
    const minutes = Number(mm)
    const seconds = Number(ss)
    if ([hours, minutes, seconds].some((v) => Number.isNaN(v))) return null
    return (hours * 3600 + minutes * 60 + seconds) * 1000
  }
  const minutes = Number(hhOrMm)
  const seconds = Number(mm)
  if ([minutes, seconds].some((v) => Number.isNaN(v))) return null
  return (minutes * 60 + seconds) * 1000
}

function extractCandidateText(response: GeminiGenerateContentResponse): string | null {
  const candidate = response.candidates?.[0]
  const parts = candidate?.content?.parts
  if (!parts) return null
  const textPart = parts.find((part) => 'text' in part) as { text: string } | undefined
  return textPart?.text ?? null
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
    }
  }>
}
