import * as THREE from 'three/webgpu'
import { EffekseerRenderPass } from 'three-effekseer'

const statusEl = document.getElementById('status')
const errorEl = document.getElementById('error')
const logEl = document.getElementById('log')

const logLine = (message) => {
  const time = new Date().toISOString().split('T')[1]?.replace('Z', '') ?? ''
  const line = time ? `[${time}] ${message}` : message
  console.log(`[webgpu-test] ${message}`)
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
  'Resources/ToonWater.efkefc'
]

const canvas = document.getElementById('canvas')
const effekseerApi = window.effekseer

if (!canvas || !effekseerApi || !('gpu' in navigator)) {
  logLine(`canvas: ${!!canvas}, effekseerApi: ${!!effekseerApi}, navigator.gpu: ${'gpu' in navigator}`)
  setError('WebGPU runtime no disponible en este navegador/contexto.')
} else {
  logLine('Modulo cargado: index_webgpu.js')
  logLine(`effekseerApi.initRuntime: ${typeof effekseerApi.initRuntime}`)
  logLine(`effekseerApi.setWebGPUDevice: ${typeof effekseerApi.setWebGPUDevice}`)
  logLine(`effekseerApi.createContext: ${typeof effekseerApi.createContext}`)

  window.addEventListener('error', (ev) => {
    logLine(`window.error: ${ev.message || ev}`)
  })
  window.addEventListener('unhandledrejection', (ev) => {
    logLine(`unhandledrejection: ${ev.reason || ev}`)
  })

  const clock = new THREE.Clock()
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30.0, canvas.width / canvas.height, 1, 1000)
  camera.position.set(20, 20, 20)
  camera.lookAt(new THREE.Vector3(0, 0, 0))

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })

  const effects = {}
  let pass = null
  let context = null
  let playContinuously = true
  let pendingFrames = 0

  window.context = null
  window.latestHandle = null

  const resize = () => {
    if (!pass) return
    const width = Math.max(1, canvas.clientWidth || canvas.width)
    const height = Math.max(1, canvas.clientHeight || canvas.height)
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    pass.setSize(width, height, pixelRatio)
  }

  const renderLoop = () => {
    if (!pass) {
      requestAnimationFrame(renderLoop)
      return
    }

    const deltaFrames = Math.max(0, clock.getDelta() * 60.0)
    if (playContinuously || pendingFrames > 0) {
      pass.render(deltaFrames || 1.0)
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
      logLine('renderer.init() start')
      await renderer.init()
      logLine('renderer.init() ok')
      const device = renderer.backend?.device
      if (!device) {
        throw new Error('WebGPU device no disponible desde Three.js')
      }
      logLine('WebGPU device ok')

      logLine('effekseerApi.setWebGPUDevice(device)')
      effekseerApi.setWebGPUDevice(device)
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
        externalRenderPass: true
      }

      const initialized = typeof context.initExternal === 'function'
        ? context.initExternal(settings)
        : context.init(canvas, settings)

      if (!initialized) {
        throw new Error('context.init fallo')
      }
      logLine(`context.init ok (initExternal=${typeof context.initExternal === 'function'})`)

      window.context = context

      const grid = new THREE.GridHelper(20, 10, 0xffffff, 0xffffff)
      scene.add(grid)

      const directionalLight = new THREE.DirectionalLight(0xffffff)
      directionalLight.position.set(0, 0.7, 0.7)
      scene.add(directionalLight)

      pass = new EffekseerRenderPass(renderer, scene, camera, context, { mode: 'composite' })
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

      setStatus('WebGPU runtime listo.')
      setError('')
      logLine('renderLoop start')
      renderLoop()
    } catch (err) {
      logLine(`init error: ${String(err && err.stack ? err.stack : err)}`)
      setError(String(err && err.stack ? err.stack : err))
    }
  }

  main()
}
