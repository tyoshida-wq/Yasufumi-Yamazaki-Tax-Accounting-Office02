import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-pages'

const GEMINI_FLASH_MODEL = 'gemini-3-flash-preview'
const GEMINI_PRO_MODEL = 'gemini-3-pro-preview'
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

app.use('/static/*', serveStatic({ root: './public' }))
app.get('/', serveStatic({ path: './public/index.html' }))
app.get('/favicon.ico', serveStatic({ path: './public/favicon.ico' }))

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
  const task: TaskRecord = {
    id: taskId,
    filename: typeof payload.filename === 'string' ? payload.filename : undefined,
    totalChunks: payload.totalChunks,
    processedChunks: 0,
    durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
    status: 'initialized',
    createdAt: now,
    updatedAt: now
  }

  await c.env.TASKS_KV.put(taskKey(taskId), JSON.stringify(task))
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

  const merged = await c.env.TASKS_KV.get(transcriptKey(taskId))
  const minutes = await c.env.TASKS_KV.get(minutesKey(taskId))
  const logs = await getTaskLogs(c.env, taskId, 40)
  const chunkSummary = await getChunkSummary(c.env, taskId)

  return c.json({
    task,
    hasMergedTranscript: merged !== null,
    hasMinutes: minutes !== null,
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

  const audioBuffer = await audio.arrayBuffer()
  const base64Audio = arrayBufferToBase64(audioBuffer)

  const job = await enqueueChunkJob(c.env, taskId, {
    index: chunkIndex,
    startMs,
    endMs,
    mimeType: audio.type || 'audio/webm',
    audioBase64: base64Audio,
    sizeBytes: audio.size
  })

  await appendTaskLog(c.env, taskId, {
    level: 'info',
    message: 'Chunk queued for transcription',
    context: {
      chunkIndex,
      startMs,
      endMs,
      sizeBytes: audio.size
    }
  })

  await ensureTaskTranscribing(c.env, task)

  // Start processing only a small batch in waitUntil to avoid timeout
  // Client will trigger further processing via /process endpoint or auto-polling
  const queuePromise = processChunkQueue(c.env, taskId, { maxIterations: 2 }).catch((error) => {
    console.error('processChunkQueue error (waitUntil)', error)
  })
  if (c.executionCtx) {
    c.executionCtx.waitUntil(queuePromise)
  } else {
    await queuePromise
  }

  return c.json({ job: sanitizeChunkJobForResponse(job) }, 202)
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
      const existingState = (await c.env.TASKS_KV.get(chunkStateKey(taskId, i), { type: 'json' })) as ChunkStateRecord | null
      await saveChunkState(c.env, taskId, {
        index: i,
        status: 'error',
        attempts: existingState?.attempts ?? 0,
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
  await c.env.TASKS_KV.put(transcriptKey(taskId), merged)

  const updatedTask: TaskRecord = {
    ...task,
    processedChunks: totalChunks,
    status: 'transcribed',
    updatedAt: new Date().toISOString()
  }
  await c.env.TASKS_KV.put(taskKey(taskId), JSON.stringify(updatedTask))
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
  const transcript = await c.env.TASKS_KV.get(transcriptKey(taskId))
  if (!transcript) {
    return c.json({ error: 'Transcript not found' }, 404)
  }
  return c.json({ transcript })
})

app.post('/api/tasks/:taskId/minutes', async (c) => {
  const taskId = c.req.param('taskId')
  const task = await getTask(c.env, taskId)
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  const transcript = await c.env.TASKS_KV.get(transcriptKey(taskId))
  if (!transcript) {
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
      transcript,
      filename: task.filename,
      durationMs: task.durationMs
    })

    const record: MinutesRecord = {
      content: minutesContent,
      createdAt: new Date().toISOString()
    }

    await c.env.TASKS_KV.put(minutesKey(taskId), JSON.stringify(record))

    const updatedTask: TaskRecord = {
      ...task,
      status: 'completed',
      updatedAt: new Date().toISOString()
    }
    await c.env.TASKS_KV.put(taskKey(taskId), JSON.stringify(updatedTask))
    await appendTaskLog(c.env, taskId, {
      level: 'info',
      message: 'Minutes generation stored',
      context: {
        minutesLength: record.content.length
      }
    })

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
  const minutes = await c.env.TASKS_KV.get(minutesKey(taskId), { type: 'json' })
  if (!minutes) {
    return c.json({ error: 'Minutes not found' }, 404)
  }
  return c.json(minutes)
})

app.get('/api/healthz', (c) => c.json({ ok: true }))

app.get('/api/tasks', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100)
  const prefix = 'task:'
  
  try {
    const list = await c.env.TASKS_KV.list({ prefix, limit: 1000 })
    const tasks: TaskRecord[] = []
    
    for (const key of list.keys) {
      // Only get main task records (task:xxxxx), skip sub-records (task:xxxxx:chunk:0)
      const colonCount = (key.name.match(/:/g) || []).length
      if (colonCount > 1) continue
      
      const task = await c.env.TASKS_KV.get<TaskRecord>(key.name, { type: 'json' })
      if (task) {
        tasks.push(task)
      }
      
      if (tasks.length >= limit) break
    }
    
    // Sort by creation date (newest first)
    tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    
    return c.json({ tasks })
  } catch (error) {
    console.error('Failed to fetch tasks:', error)
    return c.json({ error: 'Failed to fetch tasks' }, 500)
  }
})

export default app

