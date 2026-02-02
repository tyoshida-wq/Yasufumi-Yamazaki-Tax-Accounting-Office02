import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

const GEMINI_FLASH_MODEL = 'gemini-3-flash-preview'
const GEMINI_PRO_MODEL = 'gemini-3-pro-preview'
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com'

const TIMESTAMP_PATTERN = /^\s*(\d{2}):(\d{2})(?::(\d{2}))?/ // Supports mm:ss or hh:mm:ss

interface Bindings {
  GEMINI_API_KEY: string
  TASKS_KV: KVNamespace
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

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

app.use('/static/*', serveStatic({ root: './public' }))
app.get('/', serveStatic({ path: './public/index.html' }))
app.get('/favicon.ico', serveStatic({ path: './public/favicon.ico' }))

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

  return c.json({
    task,
    hasMergedTranscript: merged !== null,
    hasMinutes: minutes !== null
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
  const previousChunk = chunkIndex > 0 ? await getChunk(c.env, taskId, chunkIndex - 1) : null
  const previousContext = previousChunk ? previousChunk.text.slice(-1500) : ''

  const audioBuffer = await audio.arrayBuffer()
  const base64Audio = arrayBufferToBase64(audioBuffer)

  try {
    const transcription = await callGeminiFlashTranscription({
      apiKey,
      audioBase64: base64Audio,
      mimeType: audio.type || 'audio/webm',
      chunkIndex,
      chunkStartMs: startMs,
      chunkEndMs: endMs,
      previousContext
    })

    const now = new Date().toISOString()
    const chunkRecord: ChunkRecord = {
      index: chunkIndex,
      startMs,
      endMs,
      text: transcription,
      createdAt: now
    }

    await c.env.TASKS_KV.put(chunkKey(taskId, chunkIndex), JSON.stringify(chunkRecord))

    let processedChunks = task.processedChunks
    if (!existingChunk) {
      processedChunks = Math.min(task.totalChunks, processedChunks + 1)
    }

    const updatedTask: TaskRecord = {
      ...task,
      processedChunks,
      status: 'transcribing',
      updatedAt: now
    }
    if (updatedTask.processedChunks === task.totalChunks) {
      updatedTask.status = 'transcribed'
    }

    await c.env.TASKS_KV.put(taskKey(taskId), JSON.stringify(updatedTask))

    return c.json({ chunk: chunkRecord, task: updatedTask })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    await setTaskError(c.env, taskId, message)
    return c.json({ error: message }, 500)
  }
})

app.post('/api/tasks/:taskId/merge', async (c) => {
  const taskId = c.req.param('taskId')
  const task = await getTask(c.env, taskId)
  if (!task) {
    return c.json({ error: 'Task not found' }, 404)
  }

  if (task.processedChunks < task.totalChunks) {
    return c.json({ error: 'Transcription is not complete yet' }, 409)
  }

  const chunkRecords: ChunkRecord[] = []
  for (let i = 0; i < task.totalChunks; i++) {
    const record = await getChunk(c.env, taskId, i)
    if (!record) {
      return c.json({ error: `Missing chunk ${i}` }, 500)
    }
    chunkRecords.push(record)
  }

  const merged = mergeChunks(chunkRecords)
  await c.env.TASKS_KV.put(transcriptKey(taskId), merged)

  const updatedTask: TaskRecord = {
    ...task,
    status: 'transcribed',
    updatedAt: new Date().toISOString()
  }
  await c.env.TASKS_KV.put(taskKey(taskId), JSON.stringify(updatedTask))

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
    const minutesContent = await callGeminiMinutes({
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

    return c.json({ minutes: record })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
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

export default app

function taskKey(taskId: string) {
  return `task:${taskId}`
}

function chunkKey(taskId: string, index: number) {
  return `task:${taskId}:chunk:${index}`
}

function transcriptKey(taskId: string) {
  return `task:${taskId}:transcript`
}

function minutesKey(taskId: string) {
  return `task:${taskId}:minutes`
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

async function callGeminiFlashTranscription(params: {
  apiKey: string
  audioBase64: string
  mimeType: string
  chunkIndex: number
  chunkStartMs: number
  chunkEndMs: number
  previousContext?: string
}): Promise<string> {
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

  const response = await fetch(
    `${GEMINI_API_BASE}/v1beta/models/${GEMINI_FLASH_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        system_instruction: systemInstruction,
        contents: [
          {
            role: 'user',
            parts: userParts
          }
        ]
      })
    }
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Gemini Flash API error: ${response.status} ${errorText}`)
  }

  const data = (await response.json()) as GeminiGenerateContentResponse
  const text = extractCandidateText(data)
  if (!text) {
    throw new Error('Gemini Flash returned no transcription text')
  }
  return text.trim()
}

async function callGeminiMinutes(params: {
  apiKey: string
  transcript: string
  filename?: string
  durationMs?: number
}): Promise<string> {
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

  const response = await fetch(
    `${GEMINI_API_BASE}/v1beta/models/${GEMINI_PRO_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
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
    }
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Gemini Pro API error: ${response.status} ${errorText}`)
  }

  const data = (await response.json()) as GeminiGenerateContentResponse
  const text = extractCandidateText(data)
  if (!text) {
    throw new Error('Gemini Pro returned no minutes text')
  }
  return text.trim()
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
