const statusEl = document.getElementById('status')
const errorEl = document.getElementById('error')
const logEl = document.getElementById('log')

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
  'Resources/Arrow1.efkwg',
  'Resources/Blow1.efkwg',
  'Resources/Cure1.efkwg',
  'Resources/Light.efkefc',
  'Resources/ToonHit.efkefc',
  'Resources/ToonWater.efkefc',
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
      filePaths.forEach((path) => {
        const name = path.substring(path.lastIndexOf('/') + 1)
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
