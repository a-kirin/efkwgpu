const statusEl = document.getElementById('status')
const cpuEl = document.getElementById('cpu')
const logEl = document.getElementById('log')

const logLine = (message) => {
  const time = new Date().toISOString().split('T')[1]?.replace('Z', '') ?? ''
  const line = time ? `[${time}] ${message}` : message
  console.log(`[webgpu-sample-no-three] ${message}`)
  if (logEl) {
    logEl.textContent += `${line}\n`
    logEl.scrollTop = logEl.scrollHeight
  }
}

const setStatus = (text) => {
  if (statusEl) statusEl.textContent = text || ''
}

const setCpu = (text) => {
  if (cpuEl) cpuEl.textContent = text || ''
}

logLine('BUILD_TAG: index_webgpu_sample_no_three.js 2026-03-17T18:35Z')

const effects = {}
let ctx = null
let runtimeReady = false
let lastFrameTime = performance.now()
let spawnFrame = 0
let cpuAccum = 0
let cpuFrames = 0
let cpuStamp = performance.now()
let lastAvgMs = null
const FORCE_FIXED_DELTA = true
const FIXED_DELTA_FRAMES = 1.0

const effectList = [
  { id: 'Arrow1', path: '/tests/Resources/Arrow1.efkwg' },
  { id: 'Blow1', path: '/tests/Resources/Blow1.efkwg' },
  { id: 'Cure1', path: '/tests/Resources/Cure1.efkwg' },
]

const loadEffect = async (entry) => {
  if (!ctx?.loadEffect) {
    logLine('ctx.loadEffect not available')
    return
  }
  logLine(`loadEffect: ${entry.path}`)
  const effect = await new Promise((resolve, reject) => {
    let created = null
    created = ctx.loadEffect(entry.path, 1.0, () => resolve(created), (message, path) => {
      reject(new Error(path ? `${message} (${path})` : message))
    })
    if (!created) {
      reject(new Error(`loadEffect returned null for ${entry.id}`))
    }
  })
  effects[entry.id] = effect
  logLine(`loadEffect ok: ${entry.id}`)
}

const playEffect = (name) => {
  if (!runtimeReady) {
    logLine('play blocked: runtime not ready')
    return
  }
  const effect = effects[name]
  if (!effect || !effect.isLoaded) {
    logLine(`play blocked: effect not ready yet (${name})`)
    return
  }
  const handle = ctx.play(effect, 0, 0, 0)
  if (!handle) {
    logLine(`play returned null handle: ${name}`)
    return
  }
  handle.setLocation?.(
    Number(document.getElementById('posx')?.value || 0),
    Number(document.getElementById('posy')?.value || 0),
    Number(document.getElementById('posz')?.value || 0)
  )
  handle.setRotation?.(
    Number(document.getElementById('rotx')?.value || 0) / 180.0 * Math.PI,
    Number(document.getElementById('roty')?.value || 0) / 180.0 * Math.PI,
    Number(document.getElementById('rotz')?.value || 0) / 180.0 * Math.PI
  )
  setStatus(`Play: ${name}`)
}

const bindButtons = () => {
  const root = document.getElementById('buttons')
  if (!root) return
  root.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    const effectName = target.dataset.effect
    if (effectName) {
      playEffect(effectName)
      return
    }
    if (target.dataset.action === 'stop') {
      ctx?.stopAll?.()
      setStatus('Stop')
    }
  })
}

const resize = (canvas) => {
  if (!ctx || !(canvas instanceof HTMLCanvasElement)) return
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
  const cssWidth = Math.max(1, Math.floor(canvas.clientWidth || canvas.width))
  const cssHeight = Math.max(1, Math.floor(canvas.clientHeight || canvas.height))
  const width = Math.max(1, Math.floor(cssWidth * pixelRatio))
  const height = Math.max(1, Math.floor(cssHeight * pixelRatio))

  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height

  const aspect = Math.max(0.001, width / height)
  ctx.setProjectionPerspective?.(30, aspect, 1, 1000)
  ctx.setCameraLookAt?.(20, 20, 20, 0, 0, 0, 0, 1, 0)
}

const renderLoop = (time, canvas) => {
  if (!ctx) {
    requestAnimationFrame((t) => renderLoop(t, canvas))
    return
  }

  let deltaFrames = Math.max(0, ((time - lastFrameTime) / 1000) * 60.0)
  lastFrameTime = time
  if (!Number.isFinite(deltaFrames) || deltaFrames <= 0) {
    deltaFrames = 1.0
  }
  if (FORCE_FIXED_DELTA) {
    deltaFrames = FIXED_DELTA_FRAMES
  } else {
    deltaFrames = Math.min(deltaFrames, 1.0)
  }

  spawnFrame += 1
  if (spawnFrame % 10 === 0 && runtimeReady) {
    playEffect('Arrow1')
    playEffect('Blow1')
    playEffect('Cure1')
  }

  const cpuStart = performance.now()
  ctx.update(deltaFrames || 1.0)
  ctx.draw()
  const cpuEnd = performance.now()

  const updateUs = ctx.getUpdateTime ? ctx.getUpdateTime() || 0 : 0
  const drawUs = ctx.getDrawTime ? ctx.getDrawTime() || 0 : 0
  if (updateUs || drawUs) {
    const totalUs = updateUs + drawUs
    cpuAccum += cpuEnd - cpuStart
    cpuFrames += 1
    if (cpuEnd - cpuStamp >= 1000) {
      lastAvgMs = cpuAccum / Math.max(1, cpuFrames)
      cpuAccum = 0
      cpuFrames = 0
      cpuStamp = cpuEnd
    }
    const avgText = lastAvgMs !== null ? ` | avg ${lastAvgMs.toFixed(2)} ms/frame` : ''
    setCpu(`CPU Usage: ${Math.round(totalUs)} us (update ${Math.round(updateUs)} / draw ${Math.round(drawUs)})${avgText}`)
  } else {
    setCpu('CPU Usage: N/A (stats not available)')
  }

  requestAnimationFrame((t) => renderLoop(t, canvas))
}

const main = async () => {
  const canvas = document.getElementById('canvas')
  const effekseer = window.effekseer
  if (!canvas || !('gpu' in navigator) || !effekseer) {
    setStatus('WebGPU runtime no disponible.')
    return
  }

  bindButtons()

  try {
    logLine('effekseer.initRuntime start')
    await effekseer.initRuntime('/effekseer-runtime/Effekseer_WebGPU_Runtime.wasm')
    logLine('effekseer.initRuntime ok')

    ctx = effekseer.createContext()
    if (!ctx) {
      setStatus('createContext failed.')
      return
    }
    window.ctx = ctx

    const settings = {
      instanceMaxCount: 4000,
      squareMaxCount: 10000,
    }

    const ok = ctx.init(canvas, settings)
    if (!ok) {
      setStatus('Effekseer init failed.')
      return
    }
    // Keep WebGPU update cost comparable to WebGL by avoiding multi-substep updates.
    ctx.fixedUpdateStepFrames = 1.0
    ctx.fixedUpdateMaxSubsteps = 1
    ctx.fixedUpdateAccumulator = 0.0

    resize(canvas)
    window.addEventListener('resize', () => resize(canvas))

    for (const entry of effectList) {
      await loadEffect(entry)
    }

    runtimeReady = true
    setStatus('Runtime ready (no three).')
    logLine('renderLoop start')
    renderLoop(performance.now(), canvas)
  } catch (err) {
    logLine(`init error: ${String(err && err.stack ? err.stack : err)}`)
    setStatus('Init error (see log).')
  }
}

main()
