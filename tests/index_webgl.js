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

const background = { r: 0.86, g: 0.89, b: 0.92, a: 1 }

const logLine = (message) => {
  const time = new Date().toISOString().split('T')[1]?.replace('Z', '') ?? ''
  const line = time ? `[${time}] ${message}` : message
  console.log(`[webgl-test] ${message}`)
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

window.capturePNG = function () {
  const canvas = document.getElementById('canvas')
  return canvas ? canvas.toDataURL('image/png').substring(21) : ''
}

window.callEstimateBoundingBox = function () {
  setStatus('callEstimateBoundingBox: no disponible en WebGL runtime actual.')
}

window.callExists = function () {
  const exists = !!(window.latestHandle && window.latestHandle.exists)
  setStatus('latestHandle.exists = ' + exists)
  return exists
}

const filePaths = [
  { name: 'blood.efkefc', path: 'input/blood.efkefc' },
]

const canvas = document.getElementById('canvas')
const effekseerApi = window.effekseer

if (!canvas || !effekseerApi) {
  logLine(`canvas: ${!!canvas}, effekseerApi: ${!!effekseerApi}`)
  setError('Effekseer WebGL runtime no disponible en este navegador/contexto.')
} else {
  logLine('Modulo cargado: index_webgl.js')
  logLine(`effekseerApi.init: ${typeof effekseerApi.init}`)
  logLine(`effekseerApi.loadEffect: ${typeof effekseerApi.loadEffect}`)

  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true })
    || canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true })

  if (!gl) {
    setError('WebGL no disponible en este navegador/contexto.')
  } else {
    const effects = {}
    let playContinuously = true
    let pendingFrames = 0
    let lastFrameTime = performance.now()

    window.latestHandle = null

    const resize = () => {
      if (!(canvas instanceof HTMLCanvasElement)) return
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      const cssWidth = Math.max(1, Math.floor(canvas.clientWidth))
      const cssHeight = Math.max(1, Math.floor(canvas.clientHeight))
      const width = Math.max(1, Math.floor(cssWidth * pixelRatio))
      const height = Math.max(1, Math.floor(cssHeight * pixelRatio))

      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height

      gl.viewport(0, 0, canvas.width, canvas.height)

      const aspect = Math.max(0.001, canvas.width / canvas.height)
      effekseerApi.setProjectionPerspective?.(30, aspect, 1, 1000)
      effekseerApi.setCameraLookAt?.(20, 20, 20, 0, 0, 0, 0, 1, 0)
    }

    const renderLoop = (time) => {
      const deltaFrames = Math.max(0, ((time - lastFrameTime) / 1000) * 60.0)
      lastFrameTime = time

      if (playContinuously || pendingFrames > 0) {
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clearColor(background.r, background.g, background.b, background.a)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

        effekseerApi.update(deltaFrames || 1.0)
        effekseerApi.draw()

        const updateUs = effekseerApi.getUpdateTime ? effekseerApi.getUpdateTime() || 0 : 0
        const drawUs = effekseerApi.getDrawTime ? effekseerApi.getDrawTime() || 0 : 0
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

    try {
      effekseerApi.init(gl)
      resize()
      window.addEventListener('resize', resize)

      const buttons = document.getElementById('buttons')
      filePaths.forEach(({ name, path }) => {
        logLine(`loadEffect: ${path}`)
        const effect = effekseerApi.loadEffect(path, 1.0, () => {
          logLine(`loadEffect ok: ${path}`)
        }, (message, failedPath) => {
          logLine(`loadEffect error: ${message} ${failedPath || path}`)
        })
        effects[name] = effect
        const btn = document.createElement('input')
        btn.type = 'button'
        btn.value = name
        btn.id = name
        btn.addEventListener('click', () => {
          setStatus('Play: ' + name)
          logLine(`play: ${name}`)
          window.latestHandle = effekseerApi.play(effect, 0, 0, 0)
        })
        buttons.appendChild(btn)
      })

      setStatus('WebGL runtime listo.')
      setError('')
      logLine('renderLoop start')
      renderLoop(performance.now())
    } catch (err) {
      logLine(`init error: ${String(err && err.stack ? err.stack : err)}`)
      setError(String(err && err.stack ? err.stack : err))
    }
  }
}
