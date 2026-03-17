import bloodUrl from '../src/pkmoves/blood.efkwgpk?url'

const statusEl = document.getElementById('status')
const errorEl = document.getElementById('error')
const logEl = document.getElementById('log')
const cpuLabelEl = document.getElementById('cpu-label')
const cpuChart = document.getElementById('cpu-chart')
const cpuCtx = cpuChart instanceof HTMLCanvasElement ? cpuChart.getContext('2d') : null

const MAX_CPU_SAMPLES = 240
const cpuTotalSamples = new Array(MAX_CPU_SAMPLES).fill(0)
const cpuUpdateSamples = new Array(MAX_CPU_SAMPLES).fill(0)
const cpuDrawSamples = new Array(MAX_CPU_SAMPLES).fill(0)
let cpuSampleIndex = 0

function pushCpuSample(updateUs, drawUs) {
  const totalUs = updateUs + drawUs
  cpuTotalSamples[cpuSampleIndex] = totalUs
  cpuUpdateSamples[cpuSampleIndex] = updateUs
  cpuDrawSamples[cpuSampleIndex] = drawUs
  cpuSampleIndex = (cpuSampleIndex + 1) % MAX_CPU_SAMPLES
}

function drawCpuChart() {
  if (!cpuCtx || !(cpuChart instanceof HTMLCanvasElement)) return

  const width = cpuChart.width
  const height = cpuChart.height
  cpuCtx.clearRect(0, 0, width, height)

  cpuCtx.fillStyle = '#0a1118'
  cpuCtx.fillRect(0, 0, width, height)

  const maxSample = Math.max(1000, ...cpuTotalSamples)
  const scale = maxSample > 0 ? height / maxSample : 1

  cpuCtx.strokeStyle = '#1f2a36'
  cpuCtx.lineWidth = 1
  cpuCtx.beginPath()
  for (let i = 0; i <= 4; i += 1) {
    const y = Math.round((height / 4) * i) + 0.5
    cpuCtx.moveTo(0, y)
    cpuCtx.lineTo(width, y)
  }
  cpuCtx.stroke()

  const drawLine = (samples, color) => {
    cpuCtx.strokeStyle = color
    cpuCtx.lineWidth = 2
    cpuCtx.beginPath()
    for (let i = 0; i < MAX_CPU_SAMPLES; i += 1) {
      const sampleIndex = (cpuSampleIndex + i) % MAX_CPU_SAMPLES
      const value = samples[sampleIndex]
      const x = (i / (MAX_CPU_SAMPLES - 1)) * width
      const y = height - value * scale
      if (i === 0) {
        cpuCtx.moveTo(x, y)
      } else {
        cpuCtx.lineTo(x, y)
      }
    }
    cpuCtx.stroke()
  }

  drawLine(cpuTotalSamples, '#4bc0ff')
  drawLine(cpuUpdateSamples, '#7dff8f')
  drawLine(cpuDrawSamples, '#ffcc4b')
}

const logLine = (message) => {
  const time = new Date().toISOString().split('T')[1]?.replace('Z', '') ?? ''
  const line = time ? `[${time}] ${message}` : message
  console.log(`[canvas-only-test] ${message}`)
  if (logEl) {
    logEl.textContent += `${line}\n`
    logEl.scrollTop = logEl.scrollHeight
  }
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text || ''
}

function setError(text) {
  if (errorEl) errorEl.textContent = text || ''
}

window.capturePNG = function () {
  const canvas = document.getElementById('canvas')
  return canvas ? canvas.toDataURL('image/png').substring(21) : ''
}

window.callEstimateBoundingBox = function () {
  setStatus('callEstimateBoundingBox: no disponible en WebGPU runtime actual.')
}

window.callExists = function () {
  const exists = !!(window.latestHandle && window.latestHandle.exists)
  setStatus('latestHandle.exists = ' + exists)
  return exists
}

const filePaths = [
  { name: 'blood.efkwgpk', path: bloodUrl },
]

const canvas = document.getElementById('canvas')
const effekseerApi = window.effekseer

if (!canvas || !effekseerApi || !('gpu' in navigator)) {
  logLine(`canvas: ${!!canvas}, effekseerApi: ${!!effekseerApi}, navigator.gpu: ${'gpu' in navigator}`)
  setError('WebGPU runtime no disponible en este navegador/contexto.')
} else {
  logLine('Modulo cargado: index_canvas_only.js')
  logLine(`effekseerApi.initRuntime: ${typeof effekseerApi.initRuntime}`)
  logLine(`effekseerApi.createContext: ${typeof effekseerApi.createContext}`)

  window.addEventListener('error', (ev) => {
    logLine(`window.error: ${ev.message || ev}`)
  })
  window.addEventListener('unhandledrejection', (ev) => {
    logLine(`unhandledrejection: ${ev.reason || ev}`)
  })

  const effects = {}
  let context = null
  let playContinuously = true
  let pendingFrames = 0
  let lastFrameTime = performance.now()

  window.context = null
  window.latestHandle = null

  const resize = () => {
    if (!context || !(canvas instanceof HTMLCanvasElement)) return
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const cssWidth = Math.max(1, Math.floor(canvas.clientWidth))
    const cssHeight = Math.max(1, Math.floor(canvas.clientHeight))
    const width = Math.max(1, Math.floor(cssWidth * pixelRatio))
    const height = Math.max(1, Math.floor(cssHeight * pixelRatio))

    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    const aspect = Math.max(0.001, width / height)
    context.setProjectionPerspective?.(30, aspect, 1, 1000)
    context.setCameraLookAt?.(20, 20, 20, 0, 0, 0, 0, 1, 0)
  }

  const renderLoop = (time) => {
    if (!context) {
      requestAnimationFrame(renderLoop)
      return
    }

    const deltaFrames = Math.max(0, ((time - lastFrameTime) / 1000) * 60.0)
    lastFrameTime = time

    if (playContinuously || pendingFrames > 0) {
      context.update(deltaFrames || 1.0)
      context.draw()
      const statsCtx = context
      const updateUs = statsCtx.getUpdateTime ? statsCtx.getUpdateTime() || 0 : 0
      const drawUs = statsCtx.getDrawTime ? statsCtx.getDrawTime() || 0 : 0
      if (updateUs || drawUs) {
        pushCpuSample(updateUs, drawUs)
        const totalUs = updateUs + drawUs
        if (cpuLabelEl) {
          cpuLabelEl.textContent = `CPU Usage: ${Math.round(totalUs)} us (update ${Math.round(updateUs)} / draw ${Math.round(drawUs)})`
        }
        drawCpuChart()
      } else if (cpuLabelEl) {
        cpuLabelEl.textContent = 'CPU Usage: N/A (stats not available)'
      }
      if (!playContinuously && pendingFrames > 0) {
        pendingFrames -= 1
      }
    }

    requestAnimationFrame(renderLoop)
  }

  window.step = function (frame) {
    const count = Math.max(1, frame | 0)
    playContinuously = false
    pendingFrames += count
    setStatus('Step mode: ' + pendingFrames + ' frames pendientes')
  }

  async function main() {
    try {
      logLine('effekseerApi.initRuntime() start')
      await effekseerApi.initRuntime('/effekseer-runtime/Effekseer_WebGPU_Runtime.wasm')
      logLine('effekseerApi.initRuntime() ok')

      context = effekseerApi.createContext()
      if (!context) {
        throw new Error('createContext() devolvio null')
      }
      logLine('createContext() ok')

      const settings = {
        instanceMaxCount: 20000,
        squareMaxCount: 20000,
      }

      const initialized = context.init(canvas, settings)
      if (!initialized) {
        throw new Error('context.init fallo')
      }
      logLine('context.init ok (canvas-only)')

      window.context = context
      resize()
      window.addEventListener('resize', resize)

      const buttons = document.getElementById('buttons')
      filePaths.forEach(({ name, path }) => {
        logLine(`loadEffect: ${path}`)
        const effect = context.loadEffect(
          path,
          1.0,
          () => {
            logLine(`loadEffect ok: ${path}`)
          },
          (message, failedPath) => {
            logLine(`loadEffect error: ${message} ${failedPath || path}`)
          }
        )
        effects[name] = effect
        const btn = document.createElement('input')
        btn.type = 'button'
        btn.value = name
        btn.id = name
        btn.addEventListener('click', () => {
          setStatus('Play: ' + name)
          logLine(`play: ${name}`)
          window.latestHandle = context.play(effect, 0, 0, 0)
        })
        buttons.appendChild(btn)
      })

      setStatus('Canvas-only runtime listo.')
      setError('')
      logLine('renderLoop start')
      renderLoop(performance.now())
    } catch (err) {
      logLine(`init error: ${String(err && err.stack ? err.stack : err)}`)
      setError(String(err && err.stack ? err.stack : err))
    }
  }

  main()
}
