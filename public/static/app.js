const defaultConfig = Object.freeze({
  chunkSizeBytes: 1 * 1024 * 1024,
  overlapSeconds: 5,
  uploadConcurrency: 2, // CRITICAL: Force max 2 concurrent uploads to prevent server overload
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
const STATUS_POLL_INTERVAL_MS = 6000  // Poll every 6 seconds
const MERGE_RETRY_DELAY_MS = 6000  // Wait 6 seconds between status checks
const AUTO_REPROCESS_THRESHOLD = 300  // 300 checks × 6s = 1800s (30 minutes without progress)

const elements = {
  recordStart: document.getElementById('record-start'),
  recordStop: document.getElementById('record-stop'),
  recordStatus: document.getElementById('record-status'),
  recordTimer: document.getElementById('record-timer'),
  waveformCanvas: document.getElementById('waveform-canvas'),
  audioPlayer: document.getElementById('audio-player'),
  audioPlayerContainer: document.getElementById('audio-player-container'),
  clearAudio: document.getElementById('clear-audio'),
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
  copyMinutes: document.getElementById('copy-minutes'),
  triggerReprocess: document.getElementById('trigger-reprocess'),
  retryMerge: document.getElementById('retry-merge'),
  refreshHistory: document.getElementById('refresh-history'),
  taskHistoryContainer: document.getElementById('task-history-container')
}

const state = {
  mediaRecorder: null,
  mediaStream: null,
  audioContext: null,
  analyser: null,
  animationId: null,
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
  statusHistory: [],
  statusPollTimerId: null,
  latestStatus: null,
  waitingForMerge: false,
  lastTaskErrorMessage: null,
  lastChunkSummaryDigest: '',
  queueStalledCount: 0,
  autoReprocessInProgress: false
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

if (elements.triggerReprocess) {
  elements.triggerReprocess.addEventListener('click', async () => {
    await handleTriggerReprocess()
  })
}

if (elements.retryMerge) {
  elements.retryMerge.addEventListener('click', async () => {
    await handleRetryMerge()
  })
}

elements.recordStart.addEventListener('click', startRecording)
elements.recordStop.addEventListener('click', stopRecording)
elements.clearAudio.addEventListener('click', clearAudioPlayer)
elements.refreshHistory.addEventListener('click', loadTaskHistory)

setupDragAndDrop()
loadTaskHistory()

async function startRecording() {
  if (state.mediaRecorder || state.isProcessing) return
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    
    // Audio Context and Analyser setup for waveform visualization
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)()
    state.analyser = state.audioContext.createAnalyser()
    state.analyser.fftSize = 2048
    const source = state.audioContext.createMediaStreamSource(state.mediaStream)
    source.connect(state.analyser)
    
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
      startWaveformDrawing()
      logStatus('録音を開始しました。最大3時間まで記録できます。')
      elements.recordStatus.textContent = '録音中...'
      elements.recordStatus.classList.add('text-emerald-600')
      elements.recordStart.disabled = true
      elements.recordStop.disabled = false
      elements.fileInput.disabled = true
    }
    state.mediaRecorder.onstop = async () => {
      stopTimer()
      stopWaveformDrawing()
      const blob = new Blob(state.recordedChunks, { type: state.mediaRecorder?.mimeType || 'audio/webm' })
      if (blob.size === 0) {
        logStatus('録音データが空でした。再度お試しください。')
        resetRecordingControls()
        return
      }
      const filename = `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`
      const file = new File([blob], filename, { type: blob.type })
      
      // Show audio player with recorded audio
      showAudioPlayer(blob)
      
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
  state.audioContext = null
  state.analyser = null
  clearWaveformCanvas()
}

function cleanupMediaStream() {
  state.mediaStream?.getTracks().forEach((track) => track.stop())
  state.mediaStream = null
  if (state.audioContext) {
    state.audioContext.close()
    state.audioContext = null
  }
  state.analyser = null
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
  
  // Show audio player for uploaded/recorded file
  if (file && (file.type.startsWith('audio/') || source === 'ブラウザ録音')) {
    showAudioPlayer(file)
  }
}

async function processAudioFile(file) {
  state.isProcessing = true
  state.statusHistory = []
  state.transcript = ''
  state.minutes = ''
  state.waitingForMerge = false
  state.lastTaskErrorMessage = null
  state.lastChunkSummaryDigest = ''
  state.queueStalledCount = 0
  state.autoReprocessInProgress = false
  updateResultPanels()
  toggleResultButtons(false)
  elements.startProcessing.disabled = true
  stopStatusPolling()
  resetQueueActions()
  state.taskId = null
  state.latestStatus = null
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
    state.latestStatus = null
    logStatus(`タスク ${state.taskId} を作成しました。`)
    startStatusPolling(state.taskId)
    await fetchTaskLogs(state.taskId)
    elements.progressSummary.textContent = `処理開始: 0 / ${state.totalChunks} チャンク`

    // Upload all chunks as fast as possible (server will throttle processing)
    const uploadConcurrency = Math.max(1, Math.min(getConfig().uploadConcurrency || 2, 2)) // Force max 2
    logStatus(`並列アップロード数: ${uploadConcurrency} (サーバー側で処理速度制御)`)
    
    // Process chunks in strict batches for upload
    for (let i = 0; i < plan.chunks.length; i += uploadConcurrency) {
      const batch = plan.chunks.slice(i, i + uploadConcurrency)
      const batchNum = Math.floor(i / uploadConcurrency) + 1
      logStatus(`バッチ ${batchNum}: ${batch.length}チャンクを送信中...`)
      
      // Upload batch in parallel (but limited to uploadConcurrency)
      await Promise.all(batch.map(async (chunk) => {
        await uploadChunk(state.taskId, chunk)
      }))
      
      logStatus(`バッチ ${batchNum} 送信完了: ${Math.min(i + uploadConcurrency, plan.chunks.length)}/${plan.chunks.length} チャンク送信済み`)
      
      // Update status after each batch
      const status = await fetchTaskStatus(state.taskId)
      if (status && status.task) {
        handleStatusUpdate(status)
      }
    }

    logStatus('全チャンクの送信が完了しました。サーバーで結合準備を確認します。')
    await fetchTaskLogs(state.taskId)

    state.waitingForMerge = true
    state.queueStalledCount = 0
    const readinessStatus = await waitForReadyForMerge(state.taskId)
    if (readinessStatus) {
      handleStatusUpdate(readinessStatus)
    }

    const merged = await mergeTranscript(state.taskId)
    await fetchTaskLogs(state.taskId)

    applyMergedTranscript(merged)
    const postMergeStatus = await fetchTaskStatus(state.taskId)
    if (postMergeStatus) {
      handleStatusUpdate(postMergeStatus)
    }
    logStatus('全文文字起こしが完了しました。議事録生成ボタンからステップ2を実行できます。')
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

function startStatusPolling(taskId) {
  if (!taskId) return
  stopStatusPolling()
  state.statusPollTimerId = window.setInterval(async () => {
    try {
      const status = await fetchTaskStatus(taskId)
      if (status) {
        handleStatusUpdate(status)
      }
    } catch (error) {
      console.warn('Status poll failed', error)
    }
  }, STATUS_POLL_INTERVAL_MS)

  fetchTaskStatus(taskId)
    .then((status) => {
      if (status) {
        handleStatusUpdate(status)
      }
    })
    .catch((error) => {
      console.warn('Initial status poll failed', error)
    })
}

function stopStatusPolling() {
  if (state.statusPollTimerId) {
    clearInterval(state.statusPollTimerId)
    state.statusPollTimerId = null
  }
}

function handleStatusUpdate(status) {
  if (!status || typeof status !== 'object' || !status.task) return

  state.latestStatus = status
  const totalChunks = status.task.totalChunks ?? state.totalChunks ?? 0
  const processedChunks = status.task.processedChunks ?? 0
  updateProgress(processedChunks, totalChunks, status.chunkSummary)

  const summary = status.chunkSummary || {}
  
  // Check for errors
  if ((summary.error ?? 0) > 0) {
    logStatus('サーバー側で一部チャンクがエラー状態です。再処理ボタンから復旧してください。', 'error')
  }

  handleQueueStallDetection(summary)

  if (status.task.status === 'error' && status.task.error && state.lastTaskErrorMessage !== status.task.error) {
    state.lastTaskErrorMessage = status.task.error
    logStatus(`サーバー側でエラー: ${status.task.error}`, 'error')
  }

  updateQueueActionVisibility(status)
}

function handleQueueStallDetection(summary) {
  if (!summary || typeof summary !== 'object') {
    state.queueStalledCount = 0
    return
  }
  
  const queued = summary.queued ?? 0
  const processing = summary.processing ?? 0
  const completed = summary.completed ?? 0
  
  // Create digest to detect progress
  const currentDigest = `${completed}-${processing}-${queued}`
  
  // Debug logging
  console.log('[Stall Detection]', {
    currentDigest,
    lastDigest: state.lastChunkSummaryDigest,
    stallCount: state.queueStalledCount,
    waitingForMerge: state.waitingForMerge
  })
  
  // Only count as stalled if no progress was made
  if (queued > 0 || processing > 0) {
    // If this is the first check (digest is empty), just initialize it
    if (state.lastChunkSummaryDigest === '') {
      console.log('[Stall Detection] First check - initializing digest')
      state.lastChunkSummaryDigest = currentDigest
      state.queueStalledCount = 0
      return
    }
    
    if (currentDigest === state.lastChunkSummaryDigest) {
      // No progress since last check
      state.queueStalledCount += 1
      console.log('[Stall Detection] No progress detected, count:', state.queueStalledCount)
      
      if (
        state.waitingForMerge &&
        !state.autoReprocessInProgress &&
        state.queueStalledCount >= AUTO_REPROCESS_THRESHOLD
      ) {
        logStatus('チャンク処理の停滞を検知したため、自動的に再処理を試行します。', 'warn')
        void autoTriggerReprocess()
      }
    } else {
      // Progress detected, reset counter
      console.log('[Stall Detection] Progress detected, resetting counter')
      state.queueStalledCount = 0
      state.lastChunkSummaryDigest = currentDigest
    }
  } else {
    console.log('[Stall Detection] No queued/processing chunks, resetting')
    state.queueStalledCount = 0
    state.lastChunkSummaryDigest = ''
  }
}

function updateQueueActionVisibility(status) {
  if (!status || typeof status !== 'object') return
  const summary = status.chunkSummary || {}
  const task = status.task
  const showReprocess = shouldShowReprocess(summary, task)
  const showRetryMerge = shouldShowRetryMerge(summary, task, Boolean(status.hasMergedTranscript))

  if (elements.triggerReprocess) {
    setElementVisibility(elements.triggerReprocess, showReprocess)
    if (!showReprocess) {
      elements.triggerReprocess.disabled = false
    }
  }

  if (elements.retryMerge) {
    setElementVisibility(elements.retryMerge, showRetryMerge)
    if (!showRetryMerge) {
      elements.retryMerge.disabled = false
    }
  }
}

function shouldShowReprocess(summary, task) {
  if (!summary || typeof summary !== 'object') return false
  const totalChunks = task?.totalChunks ?? state.totalChunks ?? 0
  if ((summary.error ?? 0) > 0) {
    return true
  }
  if (state.isProcessing && (summary.error ?? 0) === 0) {
    return false
  }
  if (totalChunks > 0 && (summary.total ?? 0) < totalChunks && !state.waitingForMerge) {
    return true
  }
  if (task?.status === 'error') {
    return true
  }
  return false
}

function shouldShowRetryMerge(summary, task, hasMergedTranscript) {
  if (!summary || typeof summary !== 'object' || !task) return false
  if (hasMergedTranscript) return false
  if ((summary.error ?? 0) > 0) return false
  const totalChunks = task.totalChunks ?? state.totalChunks ?? 0
  if (!totalChunks) return false
  const pending = (summary.processing ?? 0) + (summary.queued ?? 0)
  if (pending > 0) return false
  if ((summary.completed ?? 0) < totalChunks) return false
  if ((summary.total ?? 0) < totalChunks) return false
  if (task.status === 'completed') return false
  return true
}

function setElementVisibility(element, visible) {
  if (!element) return
  element.classList.toggle('hidden', !visible)
}

function resetQueueActions() {
  state.queueStalledCount = 0
  state.autoReprocessInProgress = false
  if (elements.triggerReprocess) {
    elements.triggerReprocess.disabled = false
    setElementVisibility(elements.triggerReprocess, false)
  }
  if (elements.retryMerge) {
    elements.retryMerge.disabled = false
    setElementVisibility(elements.retryMerge, false)
  }
}

async function waitForReadyForMerge(taskId) {
  // No timeout - wait indefinitely for completion
  // Stall detection (AUTO_REPROCESS_THRESHOLD) will handle errors
  while (true) {
    try {
      const status = await fetchTaskStatus(taskId)
      if (status) {
        handleStatusUpdate(status)
        const summary = status.chunkSummary || {}
        const totalChunks = status.task?.totalChunks ?? state.totalChunks ?? 0
        const pending = (summary.processing ?? 0) + (summary.queued ?? 0)
        if ((summary.error ?? 0) > 0) {
          throw new Error('チャンク処理でエラーが発生しています。再処理ボタンから復旧してください。')
        }
        if (
          totalChunks > 0 &&
          (summary.completed ?? 0) >= totalChunks &&
          pending === 0 &&
          (summary.total ?? 0) >= totalChunks
        ) {
          return status
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('ステータスの取得に失敗しました')) {
          // wait and retry
        } else {
          throw error
        }
      } else {
        throw error
      }
    }
    await sleep(MERGE_RETRY_DELAY_MS)
  }
}

async function handleTriggerReprocess() {
  if (!state.taskId) return
  if (elements.triggerReprocess) {
    elements.triggerReprocess.disabled = true
  }
  state.queueStalledCount = 0
  logStatus('未処理チャンクの再処理をリクエストしています...')
  try {
    const response = await fetch(`/api/tasks/${state.taskId}/process?reason=manual`, { method: 'POST' })
    const data = await response.json().catch(() => ({}))
    logResponse(data)
    if (!response.ok) {
      throw new Error(data?.error || '再処理のリクエストに失敗しました')
    }
    logStatus('再処理をトリガーしました。サーバーの処理完了を待機します。')
    await fetchTaskLogs(state.taskId)
    try {
      const status = await fetchTaskStatus(state.taskId)
      if (status) {
        handleStatusUpdate(status)
      }
    } catch (statusError) {
      console.warn('Failed to refresh status after reprocess', statusError)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '再処理のリクエストに失敗しました'
    logStatus(message, 'error')
  } finally {
    if (elements.triggerReprocess) {
      elements.triggerReprocess.disabled = false
    }
  }
}

async function autoTriggerReprocess() {
  if (!state.taskId) return
  if (state.autoReprocessInProgress) return
  state.autoReprocessInProgress = true
  state.queueStalledCount = 0
  try {
    const response = await fetch(`/api/tasks/${state.taskId}/process?reason=auto&threshold=${AUTO_REPROCESS_THRESHOLD}`, { method: 'POST' })
    const data = await response.json().catch(() => ({}))
    logResponse(data)
    if (!response.ok) {
      throw new Error(data?.error || '自動再処理のリクエストに失敗しました')
    }
    logStatus('サーバーに自動再処理を依頼しました。完了まで少しお待ちください。')
    await fetchTaskLogs(state.taskId)
  } catch (error) {
    const message = error instanceof Error ? error.message : '自動再処理のリクエストに失敗しました'
    logStatus(message, 'error')
  } finally {
    state.autoReprocessInProgress = false
  }
}

async function handleRetryMerge() {
  if (!state.taskId) return
  if (elements.retryMerge) {
    elements.retryMerge.disabled = true
  }
  logStatus('結合を再試行しています...')
  try {
    state.waitingForMerge = true
    state.queueStalledCount = 0
    const readinessStatus = await waitForReadyForMerge(state.taskId)
    if (readinessStatus) {
      handleStatusUpdate(readinessStatus)
    }
    const merged = await mergeTranscript(state.taskId)
    await fetchTaskLogs(state.taskId)
    applyMergedTranscript(merged)
    logStatus('結合を再試行し、全文を取得しました。')
    try {
      const status = await fetchTaskStatus(state.taskId)
      if (status) {
        handleStatusUpdate(status)
      }
    } catch (statusError) {
      console.warn('Failed to refresh status after retry merge', statusError)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '結合の再試行に失敗しました'
    logStatus(message, 'error')
  } finally {
    state.waitingForMerge = false
    if (elements.retryMerge) {
      elements.retryMerge.disabled = false
    }
  }
}

function applyMergedTranscript(result) {
  state.waitingForMerge = false
  if (!result || typeof result !== 'object') {
    resetQueueActions()
    return
  }
  state.transcript = result.transcript || ''
  updateResultPanels()
  toggleTranscriptButtons(Boolean(state.transcript))
  elements.generateMinutes.disabled = false
  resetQueueActions()
}

async function mergeTranscript(taskId) {
  const response = await fetch(`/api/tasks/${taskId}/merge`, { method: 'POST' })
  const data = await response.json().catch(() => ({}))
  logResponse(data)

  if (!response.ok) {
    if (response.status === 409) {
      const message = data?.error || 'チャンク処理が完了していないため、結合できません。'
      logStatus(message, 'error')
      if (data?.chunkSummary && state.latestStatus) {
        state.latestStatus = {
          ...state.latestStatus,
          chunkSummary: data.chunkSummary
        }
        handleStatusUpdate(state.latestStatus)
      }
      throw new Error(message)
    }
    throw new Error(data?.error || '文字起こし結合に失敗しました')
  }

  elements.progressSummary.textContent = `結合完了: ${state.totalChunks} / ${state.totalChunks}`
  updateProgress(state.totalChunks, state.totalChunks, state.latestStatus?.chunkSummary)
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
  return `${formatBytes(config.chunkSizeBytes)} / チャンク、重複 ${config.overlapSeconds}秒、並列 ${config.uploadConcurrency}個`
}

function truncate(value, max = 160) {
  if (typeof value !== 'string') {
    value = String(value ?? '')
  }
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function startWaveformDrawing() {
  if (!state.analyser || !elements.waveformCanvas) return
  
  const canvas = elements.waveformCanvas
  const canvasCtx = canvas.getContext('2d')
  const bufferLength = state.analyser.frequencyBinCount
  const dataArray = new Uint8Array(bufferLength)
  
  function draw() {
    if (!state.analyser) return
    
    state.animationId = requestAnimationFrame(draw)
    
    state.analyser.getByteTimeDomainData(dataArray)
    
    // Clear canvas with white background
    canvasCtx.fillStyle = 'rgb(255, 255, 255)'
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height)
    
    // Draw center line
    canvasCtx.strokeStyle = 'rgb(226, 232, 240)'
    canvasCtx.lineWidth = 1
    canvasCtx.beginPath()
    canvasCtx.moveTo(0, canvas.height / 2)
    canvasCtx.lineTo(canvas.width, canvas.height / 2)
    canvasCtx.stroke()
    
    // Draw waveform with increased amplitude
    canvasCtx.lineWidth = 2.5
    canvasCtx.strokeStyle = 'rgb(16, 185, 129)'
    canvasCtx.beginPath()
    
    const sliceWidth = canvas.width / bufferLength
    let x = 0
    
    for (let i = 0; i < bufferLength; i++) {
      // Normalize value from 0-255 to -1 to 1, then amplify
      const v = (dataArray[i] - 128) / 128.0
      // Amplify the signal by 3x and add offset to center
      const y = (canvas.height / 2) + (v * canvas.height / 2 * 3)
      
      if (i === 0) {
        canvasCtx.moveTo(x, y)
      } else {
        canvasCtx.lineTo(x, y)
      }
      
      x += sliceWidth
    }
    
    canvasCtx.stroke()
  }
  
  draw()
}

function stopWaveformDrawing() {
  if (state.animationId) {
    cancelAnimationFrame(state.animationId)
    state.animationId = null
  }
}

function clearWaveformCanvas() {
  if (!elements.waveformCanvas) return
  const canvas = elements.waveformCanvas
  const canvasCtx = canvas.getContext('2d')
  canvasCtx.fillStyle = 'rgb(255, 255, 255)'
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height)
}

function showAudioPlayer(blob) {
  if (!elements.audioPlayer || !elements.audioPlayerContainer) return
  
  // Revoke previous object URL if exists
  const oldSrc = elements.audioPlayer.src
  if (oldSrc && oldSrc.startsWith('blob:')) {
    URL.revokeObjectURL(oldSrc)
  }
  
  // Create new object URL and set to audio player
  const url = URL.createObjectURL(blob)
  elements.audioPlayer.src = url
  elements.audioPlayerContainer.classList.remove('hidden')
}

function clearAudioPlayer() {
  if (!elements.audioPlayer || !elements.audioPlayerContainer) return
  
  // Pause and reset player
  elements.audioPlayer.pause()
  elements.audioPlayer.currentTime = 0
  
  // Revoke object URL
  const oldSrc = elements.audioPlayer.src
  if (oldSrc && oldSrc.startsWith('blob:')) {
    URL.revokeObjectURL(oldSrc)
  }
  
  elements.audioPlayer.src = ''
  elements.audioPlayerContainer.classList.add('hidden')
  
  // Clear selected file
  state.selectedFile = null
  state.selectedSource = null
  elements.fileSummary.textContent = '音声ファイルが未選択です。'
  elements.startProcessing.disabled = true
  
  logStatus('録音データを削除しました。')
}

async function loadTaskHistory() {
  if (!elements.taskHistoryContainer) return
  
  elements.taskHistoryContainer.innerHTML = '<div class="text-center text-sm text-slate-500 py-8">履歴を読み込んでいます...</div>'
  
  try {
    const response = await fetch('/api/tasks?limit=20')
    if (!response.ok) {
      throw new Error('Failed to fetch task history')
    }
    
    const data = await response.json()
    const tasks = data.tasks || []
    
    if (tasks.length === 0) {
      elements.taskHistoryContainer.innerHTML = '<div class="text-center text-sm text-slate-500 py-8">タスク履歴がありません</div>'
      return
    }
    
    const historyHTML = tasks.map(task => createTaskHistoryItem(task)).join('')
    elements.taskHistoryContainer.innerHTML = historyHTML
    
    // Add click event listeners to each task item
    tasks.forEach(task => {
      const element = document.getElementById(`task-${task.id}`)
      if (element) {
        element.addEventListener('click', () => loadTaskDetails(task.id))
      }
    })
  } catch (error) {
    console.error('Failed to load task history:', error)
    elements.taskHistoryContainer.innerHTML = '<div class="text-center text-sm text-red-500 py-8">履歴の読み込みに失敗しました</div>'
  }
}

function createTaskHistoryItem(task) {
  const statusBadge = getTaskStatusBadge(task.status)
  const createdDate = new Date(task.createdAt).toLocaleString('ja-JP')
  const duration = task.durationMs ? formatDurationJa(task.durationMs) : '不明'
  
  return `
    <div id="task-${task.id}" class="cursor-pointer rounded-lg border border-slate-200 bg-white p-4 transition hover:border-indigo-300 hover:shadow-md">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1 space-y-2">
          <div class="flex items-center gap-2">
            <h4 class="font-medium text-slate-900">${task.filename || 'ファイル名なし'}</h4>
            ${statusBadge}
          </div>
          <div class="text-xs text-slate-500 space-y-1">
            <div>タスクID: ${task.id}</div>
            <div>作成日時: ${createdDate}</div>
            <div>チャンク数: ${task.totalChunks} / 処理済み: ${task.processedChunks}</div>
            ${duration !== '不明' ? `<div>音声長: ${duration}</div>` : ''}
          </div>
        </div>
        <div class="text-right">
          <button class="text-indigo-600 hover:text-indigo-800 text-sm font-medium">
            詳細を表示 →
          </button>
        </div>
      </div>
    </div>
  `
}

function getTaskStatusBadge(status) {
  const badges = {
    initialized: '<span class="inline-flex items-center rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">初期化済み</span>',
    transcribing: '<span class="inline-flex items-center rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700">文字起こし中</span>',
    transcribed: '<span class="inline-flex items-center rounded-full bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700">文字起こし完了</span>',
    summarizing: '<span class="inline-flex items-center rounded-full bg-indigo-100 px-2 py-1 text-xs font-medium text-indigo-700">議事録生成中</span>',
    completed: '<span class="inline-flex items-center rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-700">完了</span>',
    error: '<span class="inline-flex items-center rounded-full bg-red-100 px-2 py-1 text-xs font-medium text-red-700">エラー</span>'
  }
  return badges[status] || badges.initialized
}

function formatDurationJa(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  
  if (hours > 0) {
    return `${hours}時間${minutes}分${seconds}秒`
  } else if (minutes > 0) {
    return `${minutes}分${seconds}秒`
  } else {
    return `${seconds}秒`
  }
}

async function loadTaskDetails(taskId) {
  try {
    // Scroll to results section
    document.querySelector('section:nth-of-type(3)')?.scrollIntoView({ behavior: 'smooth' })
    
    logStatus(`タスク ${taskId} の詳細を読み込んでいます...`)
    
    // Set current task ID
    state.taskId = taskId
    
    // Fetch task status
    const statusResponse = await fetch(`/api/tasks/${taskId}/status`)
    if (!statusResponse.ok) {
      throw new Error('Failed to fetch task status')
    }
    
    const statusData = await statusResponse.json()
    logResponse(statusData)
    
    // Update UI with task data
    if (statusData.task) {
      const task = statusData.task
      elements.progressSummary.textContent = `${task.status} - ${task.processedChunks}/${task.totalChunks} チャンク処理済み`
      
      const progress = task.totalChunks > 0 ? (task.processedChunks / task.totalChunks) * 100 : 0
      elements.progressBar.style.width = `${progress}%`
    }
    
    // Load transcript if available
    if (statusData.hasTranscript) {
      const transcriptResponse = await fetch(`/api/tasks/${taskId}/transcript`)
      if (transcriptResponse.ok) {
        const transcriptData = await transcriptResponse.json()
        state.transcript = transcriptData.transcript || ''
        updateResultPanels()
        toggleResultButtons(true)
      }
    }
    
    // Load minutes if available
    if (statusData.hasMinutes) {
      const minutesResponse = await fetch(`/api/tasks/${taskId}/minutes`)
      if (minutesResponse.ok) {
        const minutesData = await minutesResponse.json()
        state.minutes = minutesData.minutes || ''
        updateResultPanels()
      }
    }
    
    // Load server logs
    await fetchTaskLogs(taskId)
    
    logStatus(`タスク ${taskId} を読み込みました`)
  } catch (error) {
    console.error('Failed to load task details:', error)
    logStatus(`タスクの読み込みに失敗しました: ${error.message}`, 'error')
  }
}
