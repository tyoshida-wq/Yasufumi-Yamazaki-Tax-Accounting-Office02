const defaultConfig = Object.freeze({
  chunkSizeBytes: 1 * 1024 * 1024,
  overlapSeconds: 5,
  uploadConcurrency: 3,
  statusHistoryLimit: 120
})

const runtimeConfig = {
  chunkSizeBytes: defaultConfig.chunkSizeBytes,
  overlapSeconds: defaultConfig.overlapSeconds,
  uploadConcurrency: defaultConfig.uploadConcurrency,
  statusHistoryLimit: defaultConfig.statusHistoryLimit
}

const MAX_DURATION_MS = 3 * 60 * 60 * 1000 // 3 hours
const SERVER_LOG_EMPTY_TEXT = 'サーバーログはまだありません。'

const elements = {
  recordStart: document.getElementById('record-start'),
  recordStop: document.getElementById('record-stop'),
  recordStatus: document.getElementById('record-status'),
  recordTimer: document.getElementById('record-timer'),
  fileInput: document.getElementById('file-input'),
  fileSummary: document.getElementById('file-summary'),
  startProcessing: document.getElementById('start-processing'),
  progressSummary: document.getElementById('progress-summary'),
  progressBar: document.getElementById('progress-bar'),
  statusLog: document.getElementById('status-log'),
  responseLog: document.getElementById('response-log'),
  serverLog: document.getElementById('server-log'),
  chunkInfo: document.getElementById('chunk-info'),
  generateMinutes: document.getElementById('generate-minutes'),
  downloadTranscript: document.getElementById('download-transcript'),
  downloadMinutes: document.getElementById('download-minutes'),
  transcriptOutput: document.getElementById('transcript-output'),
  minutesOutput: document.getElementById('minutes-output'),
  copyTranscript: document.getElementById('copy-transcript'),
  copyMinutes: document.getElementById('copy-minutes')
}

const state = {
  mediaRecorder: null,
  mediaStream: null,
  recordTimerId: null,
  recordStartedAt: null,
  recordedChunks: [],
  selectedFile: null,
  selectedSource: null,
  isProcessing: false,
  taskId: null,
  totalChunks: 0,
  transcript: '',
  minutes: '',
  statusHistory: []
}

async function loadRuntimeConfig() {
  try {
    const response = await fetch('/api/config')
    if (!response.ok) {
      return
    }
    const data = await response.json()
    updateRuntimeConfigFromServer(data)
  } catch (error) {
    console.warn('設定の取得に失敗しました', error)
  } finally {
    applyRuntimeConfigToUI()
  }
}

function updateRuntimeConfigFromServer(data) {
  if (!data || typeof data !== 'object') return

  if (isFiniteNumber(data.chunkSizeBytes)) {
    runtimeConfig.chunkSizeBytes = clampConfigNumber(data.chunkSizeBytes, 128 * 1024, 8 * 1024 * 1024)
  }
  if (isFiniteNumber(data.overlapSeconds)) {
    runtimeConfig.overlapSeconds = clampConfigNumber(data.overlapSeconds, 0, 30)
  }

  let desiredUploadConcurrency = runtimeConfig.uploadConcurrency
  if (isFiniteNumber(data.uploadConcurrency)) {
    desiredUploadConcurrency = clampConfigNumber(data.uploadConcurrency, 1, 8)
  }
  if (isFiniteNumber(data.transcriptionConcurrency)) {
    const transcriptionConcurrency = clampConfigNumber(data.transcriptionConcurrency, 1, 8)
    desiredUploadConcurrency = Math.min(desiredUploadConcurrency, transcriptionConcurrency)
  }
  runtimeConfig.uploadConcurrency = desiredUploadConcurrency

  if (isFiniteNumber(data.statusHistoryLimit)) {
    runtimeConfig.statusHistoryLimit = clampConfigNumber(data.statusHistoryLimit, 20, 500)
  }
}

function applyRuntimeConfigToUI() {
  if (elements.chunkInfo) {
    elements.chunkInfo.textContent = getChunkInfoText()
  }
}

function getConfig() {
  return runtimeConfig
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function clampConfigNumber(value, min, max) {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return Math.floor(value)
}

if (elements.serverLog) {
  elements.serverLog.textContent = SERVER_LOG_EMPTY_TEXT
}

applyRuntimeConfigToUI()
void loadRuntimeConfig()

elements.fileInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0]
  if (file) {
    setSelectedFile(file, 'アップロード')
  }
})

elements.startProcessing.addEventListener('click', async () => {
  if (!state.selectedFile || state.isProcessing) return
  await processAudioFile(state.selectedFile)
})

elements.generateMinutes.addEventListener('click', async () => {
  if (!state.taskId) return
  try {
    await generateMinutes()
  } catch (error) {
    const message = error instanceof Error ? error.message : '議事録生成時にエラーが発生しました'
    logStatus(message, 'error')
    console.error(error)
    if (state.taskId) {
      await fetchTaskLogs(state.taskId)
    }
  }
})

elements.downloadTranscript.addEventListener('click', () => {
  if (!state.transcript) return
  downloadText(state.transcript, 'transcript.txt')
})

elements.downloadMinutes.addEventListener('click', () => {
  if (!state.minutes) return
  downloadText(state.minutes, 'minutes.md')
})

elements.copyTranscript.addEventListener('click', async () => {
  if (!state.transcript) return
  await navigator.clipboard.writeText(state.transcript)
  flashCopied(elements.copyTranscript)
})

elements.copyMinutes.addEventListener('click', async () => {
  if (!state.minutes) return
  await navigator.clipboard.writeText(state.minutes)
  flashCopied(elements.copyMinutes)
})

elements.recordStart.addEventListener('click', startRecording)
elements.recordStop.addEventListener('click', stopRecording)

setupDragAndDrop()

async function startRecording() {
  if (state.mediaRecorder || state.isProcessing) return
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = getSupportedMimeType()
    state.mediaRecorder = new MediaRecorder(state.mediaStream, mimeType ? { mimeType } : undefined)
    state.recordedChunks = []
    state.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        state.recordedChunks.push(event.data)
      }
    }
    state.mediaRecorder.onstart = () => {
      state.recordStartedAt = Date.now()
      startTimer()
      logStatus('録音を開始しました。最大3時間まで記録できます。')
      elements.recordStatus.textContent = '録音中...'
      elements.recordStatus.classList.add('text-emerald-600')
      elements.recordStart.disabled = true
      elements.recordStop.disabled = false
      elements.fileInput.disabled = true
    }
    state.mediaRecorder.onstop = async () => {
      stopTimer()
      const blob = new Blob(state.recordedChunks, { type: state.mediaRecorder?.mimeType || 'audio/webm' })
      if (blob.size === 0) {
        logStatus('録音データが空でした。再度お試しください。')
        resetRecordingControls()
        return
      }
      const filename = `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`
      const file = new File([blob], filename, { type: blob.type })
      setSelectedFile(file, 'ブラウザ録音')
      logStatus(`録音が完了しました（${formatBytes(file.size)}）。文字起こしを開始できます。`)
      resetRecordingControls()
    }

    state.mediaRecorder.start()
  } catch (error) {
    console.error(error)
    logStatus('マイクの初期化に失敗しました。マイク権限をご確認ください。', 'error')
  }
}

function stopRecording() {
  if (!state.mediaRecorder) return
  state.mediaRecorder.stop()
  cleanupMediaStream()
}

function resetRecordingControls() {
  elements.recordStart.disabled = false
  elements.recordStop.disabled = true
  elements.fileInput.disabled = false
  elements.recordStatus.textContent = 'マイクは未使用です'
  elements.recordStatus.classList.remove('text-emerald-600')
  state.mediaRecorder = null
  state.mediaStream = null
}

function cleanupMediaStream() {
  state.mediaStream?.getTracks().forEach((track) => track.stop())
  state.mediaStream = null
}

function startTimer() {
  updateTimerDisplay(0)
  state.recordTimerId = window.setInterval(() => {
    if (!state.recordStartedAt) return
    const elapsed = Date.now() - state.recordStartedAt
    updateTimerDisplay(elapsed)
    if (elapsed >= MAX_DURATION_MS) {
      logStatus('最大録音時間に達しました。自動的に停止します。')
      stopRecording()
    }
  }, 1000)
}

function stopTimer() {
  if (state.recordTimerId) {
    clearInterval(state.recordTimerId)
    state.recordTimerId = null
  }
  updateTimerDisplay(0)
}

function updateTimerDisplay(ms) {
  elements.recordTimer.textContent = formatDuration(ms)
}

function setSelectedFile(file, source) {
  state.selectedFile = file
  state.selectedSource = source
  elements.startProcessing.disabled = false
  elements.chunkInfo.textContent = getChunkInfoText()
  const summaryLines = [
    `ソース: ${source}`,
    `ファイル名: ${file.name}`,
    `サイズ: ${formatBytes(file.size)}`,
    `形式: ${file.type || '不明'}`
  ]
  elements.fileSummary.textContent = summaryLines.join('\n')
}

async function processAudioFile(file) {
  state.isProcessing = true
  state.statusHistory = []
  state.transcript = ''
  state.minutes = ''
  updateResultPanels()
  toggleResultButtons(false)
  elements.startProcessing.disabled = true
  logStatus('音声メタデータを読み込み中...')

  try {
    const durationMs = await getAudioDuration(file)
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error('音声の長さを取得できませんでした')
    }
    if (durationMs > MAX_DURATION_MS) {
      throw new Error('録音時間が3時間を超えています')
    }

    const plan = planChunks(file, durationMs)
    state.totalChunks = plan.chunks.length
    elements.chunkInfo.textContent = getChunkInfoText()
    logStatus(`音声を${state.totalChunks}チャンクに分割します。`) 

    const task = await createTask({
      totalChunks: state.totalChunks,
      filename: file.name,
      durationMs
    })

    state.taskId = task.id
    logStatus(`タスク ${state.taskId} を作成しました。`)
    await fetchTaskLogs(state.taskId)
    elements.progressSummary.textContent = `処理開始: 0 / ${state.totalChunks} チャンク`

    let nextChunkIndex = 0
    const uploadConcurrency = Math.max(1, getConfig().uploadConcurrency || 1)
    const uploadWorkers = Math.max(1, Math.min(uploadConcurrency, plan.chunks.length))

    const runUploadWorker = async () => {
      while (true) {
        const currentIndex = nextChunkIndex++
        if (currentIndex >= plan.chunks.length) {
          break
        }
        const chunk = plan.chunks[currentIndex]
        await uploadChunk(state.taskId, chunk)
        const status = await fetchTaskStatus(state.taskId)
        if (status && status.task) {
          updateProgress(status.task.processedChunks, status.task.totalChunks, status.chunkSummary)
        }
      }
    }

    await Promise.all(Array.from({ length: uploadWorkers }, () => runUploadWorker()))

    logStatus('全チャンクの送信が完了しました。サーバーで結合します。')
    const merged = await mergeTranscript(state.taskId)
    await fetchTaskLogs(state.taskId)

    state.transcript = merged.transcript
    updateResultPanels()
    toggleTranscriptButtons(true)

    logStatus('全文文字起こしが完了しました。議事録生成ボタンからステップ2を実行できます。')
    elements.generateMinutes.disabled = false
  } catch (error) {
    console.error(error)
    const message = error instanceof Error ? error.message : '不明なエラーが発生しました'
    logStatus(`処理中にエラー: ${message}`, 'error')
    if (state.taskId) {
      await fetchTaskLogs(state.taskId)
    }
  } finally {
    state.isProcessing = false
    elements.startProcessing.disabled = false
  }
}

function planChunks(file, durationMs) {
  const config = getConfig()
  const chunkSizeBytes = config.chunkSizeBytes
  const overlapSeconds = config.overlapSeconds
  const bytesPerMs = file.size / durationMs
  const overlapBytes = Math.round(bytesPerMs * overlapSeconds * 1000)
  const chunks = []
  const totalChunks = Math.ceil(file.size / chunkSizeBytes)

  const extension = detectExtension(file)

  for (let index = 0; index < totalChunks; index++) {
    const uniqueStartByte = index * chunkSizeBytes
    const uniqueEndByte = Math.min(file.size, (index + 1) * chunkSizeBytes)
    const chunkStartByte = index === 0 ? 0 : Math.max(0, uniqueStartByte - overlapBytes)
    const chunkEndByte = uniqueEndByte

    const startMs = Math.max(0, Math.round((chunkStartByte / file.size) * durationMs))
    const endMs = Math.min(durationMs, Math.round((chunkEndByte / file.size) * durationMs))

    const blob = file.slice(chunkStartByte, chunkEndByte, file.type)
    chunks.push({
      index,
      blob,
      startMs,
      endMs,
      filename: `${stripExtension(file.name)}-chunk-${index.toString().padStart(3, '0')}.${extension}`
    })
  }

  return { chunks, overlapBytes }
}

async function createTask(payload) {
  const response = await fetch('/api/tasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  const data = await response.json()
  logResponse(data)
  if (!response.ok) {
    throw new Error(data?.error || 'タスク作成に失敗しました')
  }
  return data.task
}

async function uploadChunk(taskId, chunk) {
  const formData = new FormData()
  formData.append('chunkIndex', String(chunk.index))
  formData.append('startMs', String(chunk.startMs))
  formData.append('endMs', String(chunk.endMs))
  formData.append('audio', chunk.blob, chunk.filename)

  elements.progressSummary.textContent = `送信中: チャンク ${chunk.index + 1} / ${state.totalChunks}`
  logStatus(`チャンク ${chunk.index + 1} / ${state.totalChunks} を送信`) 

  const response = await fetch(`/api/tasks/${taskId}/chunks`, {
    method: 'POST',
    body: formData
  })

  const data = await response.json()
  logResponse(data)
  if (!response.ok) {
    throw new Error(data?.error || `チャンク ${chunk.index} のアップロードに失敗しました`)
  }
}

async function fetchTaskStatus(taskId) {
  const response = await fetch(`/api/tasks/${taskId}/status`)
  let data
  try {
    data = await response.json()
  } catch (error) {
    console.warn('Failed to parse status response', error)
    throw new Error('ステータスの取得に失敗しました')
  }

  if (!response.ok) {
    const message = data?.error || 'ステータスの取得に失敗しました'
    throw new Error(message)
  }

  if (!data || typeof data !== 'object') {
    throw new Error('ステータスの取得に失敗しました')
  }

  const logs = Array.isArray(data.logs) ? data.logs : []
  updateServerLog(logs)
  return data
}

async function mergeTranscript(taskId) {
  const response = await fetch(`/api/tasks/${taskId}/merge`, { method: 'POST' })
  const data = await response.json()
  logResponse(data)
  if (!response.ok) {
    throw new Error(data?.error || '文字起こし結合に失敗しました')
  }
  elements.progressSummary.textContent = `結合完了: ${state.totalChunks} / ${state.totalChunks}`
  updateProgress(state.totalChunks, state.totalChunks)
  return data
}

async function generateMinutes() {
  if (!state.taskId) return
  elements.generateMinutes.disabled = true
  logStatus('Gemini Proで議事録を生成中...')
  const response = await fetch(`/api/tasks/${state.taskId}/minutes`, {
    method: 'POST'
  })
  const data = await response.json()
  logResponse(data)
  if (!response.ok) {
    elements.generateMinutes.disabled = false
    throw new Error(data?.error || '議事録生成に失敗しました')
  }
  state.minutes = data.minutes.content
  updateResultPanels()
  toggleMinutesButtons(true)
  logStatus('議事録の生成が完了しました。')
  await fetchTaskLogs(state.taskId)
}

function updateProgress(processed, total, summary) {
  const safeTotal = Math.max(total, 0)
  const percent = safeTotal === 0 ? 0 : Math.round((processed / safeTotal) * 100)
  elements.progressBar.style.width = `${percent}%`
  let summaryText = `進捗: ${processed} / ${safeTotal} チャンク (${percent}%)`
  if (summary && typeof summary === 'object') {
    const queued = summary.queued ?? 0
    const processing = summary.processing ?? 0
    const completed = summary.completed ?? 0
    const error = summary.error ?? 0
    summaryText += ` ｜ 待機 ${queued}・処理中 ${processing}・完了 ${completed}・エラー ${error}`
  }
  elements.progressSummary.textContent = summaryText
}

function logStatus(message, level = 'info') {
  const timestamp = new Date().toLocaleTimeString('ja-JP', { hour12: false })
  const line = `[${timestamp}] ${message}`
  state.statusHistory.push({ message: line, level })
  const historyLimit = getConfig().statusHistoryLimit || defaultConfig.statusHistoryLimit
  if (state.statusHistory.length > historyLimit) {
    state.statusHistory.shift()
  }
  elements.statusLog.textContent = state.statusHistory.map((entry) => entry.message).join('\n')

  if (state.statusHistory.some((entry) => entry.level === 'error')) {
    elements.statusLog.classList.add('text-rose-300')
  } else {
    elements.statusLog.classList.remove('text-rose-300')
  }
}

function logResponse(data) {
  const summarized = JSON.stringify(data, null, 2)
  elements.responseLog.textContent = summarized
}

function updateServerLog(entries) {
  if (!elements.serverLog) return
  if (!Array.isArray(entries) || entries.length === 0) {
    elements.serverLog.textContent = SERVER_LOG_EMPTY_TEXT
    return
  }
  const lines = entries
    .map((entry) => formatServerLogLine(entry))
    .filter((line) => line.length > 0)
  elements.serverLog.textContent = lines.length > 0 ? lines.join('\n') : SERVER_LOG_EMPTY_TEXT
}

function formatServerLogLine(entry) {
  if (!entry || typeof entry !== 'object') return ''
  const time = formatServerLogTimestamp(entry.timestamp)
  const level = typeof entry.level === 'string' ? entry.level.toUpperCase() : 'INFO'
  const message = typeof entry.message === 'string' ? entry.message : ''
  let contextText = ''
  if (entry.context && typeof entry.context === 'object') {
    try {
      const json = JSON.stringify(entry.context)
      if (json && json !== '{}') {
        contextText = ` ${truncate(json, 160)}`
      }
    } catch (error) {
      console.warn('Failed to stringify server log context', error)
    }
  }
  return `[${time}] (${level}) ${message}${contextText}`
}

function formatServerLogTimestamp(value) {
  if (typeof value !== 'string') return '--:--:--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString('ja-JP', { hour12: false })
}

async function fetchTaskLogs(taskId) {
  if (!taskId) return
  try {
    const response = await fetch(`/api/tasks/${taskId}/logs?limit=60`)
    if (!response.ok) {
      if (response.status !== 404) {
        console.warn('Failed to fetch task logs', response.status)
      }
      return
    }
    const data = await response.json()
    updateServerLog(Array.isArray(data.logs) ? data.logs : [])
  } catch (error) {
    console.warn('Failed to fetch task logs', error)
  }
}

function updateResultPanels() {
  elements.transcriptOutput.textContent = state.transcript || 'まだ文字起こしは完了していません。'
  elements.minutesOutput.textContent = state.minutes || '議事録生成は未実行です。'
}

function toggleResultButtons(enabled) {
  toggleTranscriptButtons(enabled)
  toggleMinutesButtons(enabled && Boolean(state.minutes))
}

function toggleTranscriptButtons(enabled) {
  elements.downloadTranscript.disabled = !enabled
  elements.copyTranscript.disabled = !enabled
}

function toggleMinutesButtons(enabled) {
  elements.downloadMinutes.disabled = !enabled
  elements.copyMinutes.disabled = !enabled
}

async function getAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio')
    audio.preload = 'metadata'
    audio.src = URL.createObjectURL(file)
    audio.onloadedmetadata = () => {
      if (isFinite(audio.duration)) {
        resolve(audio.duration * 1000)
      } else {
        audio.currentTime = Number.MAX_SAFE_INTEGER
        audio.ontimeupdate = () => {
          audio.ontimeupdate = null
          resolve(audio.duration * 1000)
        }
      }
      URL.revokeObjectURL(audio.src)
    }
    audio.onerror = () => {
      URL.revokeObjectURL(audio.src)
      reject(new Error('音声の読み込みに失敗しました'))
    }
  })
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const value = bytes / Math.pow(k, i)
  return `${value.toFixed(2)} ${sizes[i]}`
}

function getChunkInfoText() {
  const config = getConfig()
  return `${formatBytes(config.chunkSizeBytes)} / チャンク、重複 ${config.overlapSeconds}秒`
}

function truncate(value, max = 160) {
  if (typeof value !== 'string') {
    value = String(value ?? '')
  }
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function detectExtension(file) {
  const fromName = getExtension(file.name)
  if (fromName) return fromName
  const fromMime = guessExtensionFromMime(file.type)
  return fromMime || 'bin'
}

function getExtension(name) {
  const match = name.match(/\.([0-9a-zA-Z]+)$/)
  return match ? match[1].toLowerCase() : ''
}

function stripExtension(name) {
  return name.replace(/\.[^/.]+$/, '')
}

function guessExtensionFromMime(mime) {
  if (!mime) return ''
  const mapping = {
    'audio/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'audio/ogg': 'ogg'
  }
  return mapping[mime] || ''
}

function flashCopied(button) {
  const original = button.textContent
  button.textContent = 'コピーしました'
  setTimeout(() => {
    button.textContent = original
  }, 1500)
}

function getSupportedMimeType() {
  const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  return mimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || ''
}

function setupDragAndDrop() {
  const dropZone = document.querySelector('[data-dropzone]')
  if (!dropZone) return
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault()
    dropZone.classList.add('ring-2', 'ring-indigo-400')
  })
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('ring-2', 'ring-indigo-400')
  })
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault()
    dropZone.classList.remove('ring-2', 'ring-indigo-400')
    const file = event.dataTransfer?.files?.[0]
    if (file) {
      setSelectedFile(file, 'ドラッグ＆ドロップ')
    }
  })
}
