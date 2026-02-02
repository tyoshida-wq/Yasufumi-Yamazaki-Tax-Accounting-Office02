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
  TASKS_KV: KVNamespace
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

function taskKey(taskId: string) {
  return `task:${taskId}`
}

function chunkKey(taskId: string, index: number) {
  return `task:${taskId}:chunk:${index}`
}

function chunkJobKey(taskId: string, index: number) {
  return `task:${taskId}:job:${index}`
}

function chunkJobPrefix(taskId: string) {
  return `task:${taskId}:job:`
}

function chunkStateKey(taskId: string, index: number) {
  return `task:${taskId}:chunk-state:${index}`
}

function chunkStatePrefix(taskId: string) {
  return `task:${taskId}:chunk-state:`
}

function transcriptKey(taskId: string) {
  return `task:${taskId}:transcript`
}

function minutesKey(taskId: string) {
  return `task:${taskId}:minutes`
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
  const key = chunkJobKey(taskId, input.index)
  const existing = (await env.TASKS_KV.get(key, { type: 'json' })) as ChunkJobRecord | null
  const now = new Date().toISOString()

  const job: ChunkJobRecord = {
    index: input.index,
    startMs: input.startMs,
    endMs: input.endMs,
    mimeType: input.mimeType,
    audioBase64: input.audioBase64,
    sizeBytes: input.sizeBytes,
    attempts: existing?.attempts ?? 0,
    status: 'queued',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastError: undefined,
    processingBy: undefined,
    retryAt: undefined
  }

  await env.TASKS_KV.put(key, JSON.stringify(job))
  await saveChunkState(env, taskId, {
    index: job.index,
    status: 'queued',
    attempts: job.attempts,
    updatedAt: now
  })

  return job
}

async function ensureTaskTranscribing(env: Bindings, task: TaskRecord): Promise<TaskRecord> {
  if (task.status === 'initialized') {
    const updated: TaskRecord = {
      ...task,
      status: 'transcribing',
      updatedAt: new Date().toISOString()
    }
    await env.TASKS_KV.put(taskKey(task.id), JSON.stringify(updated))
    return updated
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
  const jobs: ChunkJobRecord[] = []
  const prefix = chunkJobPrefix(taskId)
  let cursor: string | undefined
  const now = Date.now()

  while (jobs.length < limit) {
    const list = await env.TASKS_KV.list({ prefix, limit: batchLimit, cursor })
    if (list.keys.length === 0) {
      if (!list.cursor) {
        break
      }
      cursor = list.cursor
      continue
    }

    const fetched = await Promise.all(
      list.keys.map((entry) => env.TASKS_KV.get(entry.name, { type: 'json' }) as Promise<ChunkJobRecord | null>)
    )

    for (const job of fetched) {
      if (!job) continue
      if (job.status !== 'queued') continue
      if (job.retryAt && Date.parse(job.retryAt) > now) continue
      jobs.push(job)
      if (jobs.length >= limit) {
        break
      }
    }

    if (list.list_complete || !list.cursor) {
      break
    }
    cursor = list.cursor
  }

  return jobs.sort((a, b) => a.index - b.index).slice(0, limit)
}

async function claimChunkJob(env: Bindings, taskId: string, index: number, workerId: string): Promise<ChunkJobRecord | null> {
  const key = chunkJobKey(taskId, index)
  const job = (await env.TASKS_KV.get(key, { type: 'json' })) as ChunkJobRecord | null
  if (!job) return null
  if (job.status !== 'queued') return null
  if (job.retryAt && Date.parse(job.retryAt) > Date.now()) return null

  const now = new Date().toISOString()
  const updated: ChunkJobRecord = {
    ...job,
    status: 'processing',
    processingBy: workerId,
    updatedAt: now
  }
  await env.TASKS_KV.put(key, JSON.stringify(updated))
  const confirmed = (await env.TASKS_KV.get(key, { type: 'json' })) as ChunkJobRecord | null
  if (!confirmed || confirmed.processingBy !== workerId || confirmed.status !== 'processing') {
    return null
  }
  return confirmed
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

    await env.TASKS_KV.put(chunkKey(taskId, claimed.index), JSON.stringify(chunkRecord))
    await env.TASKS_KV.delete(chunkJobKey(taskId, claimed.index))

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

  const updatedJob: ChunkJobRecord = {
    ...job,
    attempts: attemptNumber,
    status: nextStatus,
    updatedAt: nowIso,
    lastError: truncateString(message, 200),
    processingBy: undefined,
    retryAt: retryable ? new Date(Date.now() + retryDelayMs).toISOString() : undefined
  }

  await env.TASKS_KV.put(chunkJobKey(taskId, job.index), JSON.stringify(updatedJob))
  await saveChunkState(env, taskId, {
    index: job.index,
    status: nextStatus,
    attempts: attemptNumber,
    updatedAt: nowIso,
    lastError: truncateString(message, 200)
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
  await env.TASKS_KV.put(chunkStateKey(taskId, state.index), JSON.stringify(state))
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
  const prefix = chunkStatePrefix(taskId)
  let cursor: string | undefined
  const records: ChunkStateRecord[] = []

  do {
    const list = await env.TASKS_KV.list({ prefix, limit: 200, cursor })
    if (list.keys.length === 0) {
      cursor = list.cursor
      continue
    }

    const fetched = await Promise.all(
      list.keys.map((entry) => env.TASKS_KV.get(entry.name, { type: 'json' }) as Promise<ChunkStateRecord | null>)
    )

    for (const record of fetched) {
      if (record) {
        records.push(record)
      }
    }

    cursor = list.cursor
  } while (cursor)

  return records
}

async function updateTaskProgress(env: Bindings, taskId: string): Promise<TaskRecord | null> {
  const task = await getTask(env, taskId)
  if (!task) return null

  const summary = await getChunkSummary(env, taskId)
  const processedChunks = summary.completed
  const nowIso = new Date().toISOString()

  if (task.status === 'error') {
    const errored: TaskRecord = {
      ...task,
      processedChunks,
      updatedAt: nowIso
    }
    await env.TASKS_KV.put(taskKey(taskId), JSON.stringify(errored))
    return errored
  }

  let status: TaskStatus = task.status
  if (processedChunks >= task.totalChunks && task.totalChunks > 0) {
    status = 'transcribed'
  } else if (processedChunks > 0 && status === 'initialized') {
    status = 'transcribing'
  } else if (processedChunks > 0 && status !== 'completed') {
    status = 'transcribing'
  }

  const updated: TaskRecord = {
    ...task,
    processedChunks,
    status,
    updatedAt: nowIso
  }

  await env.TASKS_KV.put(taskKey(taskId), JSON.stringify(updated))
  return updated
}

async function getTask(env: Bindings, taskId: string): Promise<TaskRecord | null> {
  const stored = await env.TASKS_KV.get(taskKey(taskId), { type: 'json' })
  return (stored as TaskRecord | null) ?? null
}

async function getChunk(env: Bindings, taskId: string, index: number): Promise<ChunkRecord | null> {
  const stored = await env.TASKS_KV.get(chunkKey(taskId, index), { type: 'json' })
  return (stored as ChunkRecord | null) ?? null
}

async function setTaskError(env: Bindings, taskId: string, message: string) {
  const task = await getTask(env, taskId)
  if (!task) return
  const updated: TaskRecord = {
    ...task,
    status: 'error',
    error: message,
    updatedAt: new Date().toISOString()
  }
  await env.TASKS_KV.put(taskKey(taskId), JSON.stringify(updated))
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
    const existing = (await env.TASKS_KV.get(taskLogKey(taskId), { type: 'json' })) as TaskLogEntry[] | null
    const logs = Array.isArray(existing) ? [...existing] : []
    const context = sanitizeLogContext(entry.context)
    const logEntry: TaskLogEntry = {
      timestamp,
      level: entry.level,
      message: entry.message,
      ...(context ? { context } : {})
    }
    logs.push(logEntry)
    const trimmed = logs.length > TASK_LOG_LIMIT ? logs.slice(-TASK_LOG_LIMIT) : logs
    await env.TASKS_KV.put(taskLogKey(taskId), JSON.stringify(trimmed))
  } catch (error) {
    console.error('appendTaskLog failed', error)
  }
}

async function getTaskLogs(env: Bindings, taskId: string, limit = 40): Promise<TaskLogEntry[]> {
  const stored = (await env.TASKS_KV.get(taskLogKey(taskId), { type: 'json' })) as TaskLogEntry[] | null
  if (!stored || !Array.isArray(stored)) {
    return []
  }
  if (stored.length <= limit) {
    return stored
  }
  return stored.slice(-limit)
}

function taskLogKey(taskId: string) {
  return `task:${taskId}:logs`
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
