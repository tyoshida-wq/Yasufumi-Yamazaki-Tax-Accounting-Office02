const CHUNK_SIZE_BYTES = 5 * 1024 * 1024 // 5MB
const OVERLAP_SECONDS = 5
const MAX_DURATION_MS = 3 * 60 * 60 * 1000 // 3 hours
const STATUS_HISTORY_LIMIT = 120

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
  elements.chunkInfo.textContent = `${(CHUNK_SIZE_BYTES / (1024 * 1024)).toFixed(1)}MB / チャンク`
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
    elements.chunkInfo.textContent = `${formatBytes(CHUNK_SIZE_BYTES)} / チャンク、重複 ${OVERLAP_SECONDS}秒`
    logStatus(`音声を${state.totalChunks}チャンクに分割します。`) 

    const task = await createTask({
      totalChunks: state.totalChunks,
      filename: file.name,
      durationMs
    })

    state.taskId = task.id
    logStatus(`タスク ${state.taskId} を作成しました。`) 
    elements.progressSummary.textContent = `処理開始: 0 / ${state.totalChunks} チャンク`

    for (const chunk of plan.chunks) {
      await uploadChunk(state.taskId, chunk)
      const status = await fetchTaskStatus(state.taskId)
      updateProgress(status.task.processedChunks, status.task.totalChunks)
    }

    logStatus('全チャンクの送信が完了しました。サーバーで結合します。')
    const merged = await mergeTranscript(state.taskId)

    state.transcript = merged.transcript
    updateResultPanels()
    toggleTranscriptButtons(true)

    logStatus('全文文字起こしが完了しました。議事録生成ボタンからステップ2を実行できます。')
    elements.generateMinutes.disabled = false
  } catch (error) {
    console.error(error)
    const message = error instanceof Error ? error.message : '不明なエラーが発生しました'
    logStatus(`処理中にエラー: ${message}`, 'error')
  } finally {
    state.isProcessing = false
    elements.startProcessing.disabled = false
  }
}

function planChunks(file, durationMs) {
  const bytesPerMs = file.size / durationMs
  const overlapBytes = Math.round(bytesPerMs * OVERLAP_SECONDS * 1000)
  const chunks = []
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE_BYTES)

  const extension = detectExtension(file)

  for (let index = 0; index < totalChunks; index++) {
    const uniqueStartByte = index * CHUNK_SIZE_BYTES
    const uniqueEndByte = Math.min(file.size, (index + 1) * CHUNK_SIZE_BYTES)
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
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data?.error || 'ステータスの取得に失敗しました')
  }
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
}

function updateProgress(processed, total) {
  const percent = total === 0 ? 0 : Math.round((processed / total) * 100)
  elements.progressBar.style.width = `${percent}%`
  elements.progressSummary.textContent = `進捗: ${processed} / ${total} チャンク (${percent}%)`
}

function logStatus(message, level = 'info') {
  const timestamp = new Date().toLocaleTimeString('ja-JP', { hour12: false })
  const line = `[${timestamp}] ${message}`
  state.statusHistory.push({ message: line, level })
  if (state.statusHistory.length > STATUS_HISTORY_LIMIT) {
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
