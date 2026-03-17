import * as THREE from 'three/webgpu'
import { EffekseerRenderPass } from 'three-effekseer'

const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')

const logLine = (message) => {
  const time = new Date().toISOString().split('T')[1]?.replace('Z', '') ?? ''
  const line = time ? `[${time}] ${message}` : message
  console.log(`[webgpu-sample] ${message}`)
  if (logEl) {
    logEl.textContent += `${line}\n`
    logEl.scrollTop = logEl.scrollHeight
  }
}

const setStatus = (text) => {
  if (statusEl) statusEl.textContent = text || ''
}

logLine('BUILD_TAG: index_webgpu_sample.js 2026-03-17T18:05Z')

const effects = {}
let ctx = null
let runtimeReady = false

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
  const response = await fetch(entry.path)
  if (!response.ok) {
    logLine(`loadEffect fetch error: ${response.status} ${entry.path}`)
    return
  }
  const buffer = await response.arrayBuffer()
  const effect = await new Promise((resolve, reject) => {
    let created = null
    created = ctx.loadEffect(
      buffer,
      1.0,
      () => resolve(created),
      (message, path) => reject(new Error(path ? `${message} (${path})` : message))
    )
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
  logLine(`play: ${name}`)
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

const main = async () => {
  const canvas = document.getElementById('canvas')
  const effekseer = window.effekseer
  if (!canvas || !('gpu' in navigator) || !effekseer) {
    setStatus('WebGPU runtime no disponible.')
    return
  }

  bindButtons()

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
  await renderer.init()
  renderer.setClearColor(0x000000, 1)
  const device = renderer.backend?.device
  if (!device) {
    setStatus('WebGPU device not available.')
    return
  }

  effekseer.setWebGPUDevice(device)
  await effekseer.initRuntime('/effekseer-runtime/Effekseer_WebGPU_Runtime.wasm')
  effekseer.setLogEnabled?.(true)

  ctx = effekseer.createContext()
  if (!ctx) {
    setStatus('createContext failed.')
    return
  }
  const settings = {
    instanceMaxCount: 20000,
    squareMaxCount: 20000,
    externalRenderPass: true,
  }
  const ok = typeof ctx.initExternal === 'function'
    ? ctx.initExternal(settings)
    : ctx.init(canvas, settings)
  if (!ok) {
    setStatus('Effekseer init failed.')
    return
  }

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  const camera = new THREE.PerspectiveCamera(30.0, canvas.width / canvas.height, 1, 1000)
  camera.position.set(20, 20, 20)
  camera.lookAt(new THREE.Vector3(0, 0, 0))

  const grid = new THREE.GridHelper(20, 10, 0xffffff, 0xffffff)
  scene.add(grid)
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshBasicMaterial({ color: 0xff4444 })
  )
  mesh.position.set(0, 1, 0)
  scene.add(mesh)

  const pass = new EffekseerRenderPass(renderer, scene, camera, ctx, { mode: 'composite' })
  pass.setSize(canvas.width, canvas.height, 1)

  await Promise.all(effectList.map(loadEffect))
  runtimeReady = true
  setStatus('Runtime ready.')

  const clock = new THREE.Clock()
  const renderLoop = () => {
    requestAnimationFrame(renderLoop)
    mesh.rotation.y += 0.01
    mesh.rotation.z += 0.01
    pass.render(Math.max(0, clock.getDelta() * 60.0))
  }
  renderLoop()
}

window.addEventListener('DOMContentLoaded', () => {
  main().catch((err) => {
    logLine(`init error: ${err instanceof Error ? err.message : String(err)}`)
  })
})
