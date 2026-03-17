import * as THREE from 'three/webgpu'
import effectUrl from './pkmoves/blood.efkwgpk?url'
import {
  EffekseerRenderPass,
  type EffekseerHandle,
} from 'three-effekseer'

type WebGPUBackendWithDevice = {
  device: GPUDevice | null
}

const isHandleAlive = (value: EffekseerHandle | null): boolean => {
  if (!value) return false
  const handleWithExists = value as EffekseerHandle & { exists?: boolean }
  return handleWithExists.exists !== false
}

async function main(): Promise<void> {
  const canvas = document.getElementById('viewer-canvas')
  // Effekseer runtime loaded by the page scripts.
  const effekseer = window.effekseer

  if (!(canvas instanceof HTMLCanvasElement) || !('gpu' in navigator) || !effekseer) return

  let cancelled = false
  let handle: EffekseerHandle | null = null
  const timer = new THREE.Timer()
  timer.connect(document)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#000000')

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
  camera.position.set(9, 4.5, 9)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 1, 0)

  const grid = new THREE.GridHelper(20, 10, 0xffffff, 0xffffff)
  const geometry = new THREE.BoxGeometry(2, 2, 2)
  const material = new THREE.MeshBasicMaterial({ color: '#cc4c4c' })
  const mesh = new THREE.Mesh(geometry, material)

  scene.add(grid, mesh)

  let cleanup = () => {
    cancelled = true
    geometry.dispose()
    material.dispose()
    timer.dispose()
  }

  // Setup WebGPURenderer
  const renderer = new THREE.WebGPURenderer({
    canvas,
    alpha: false,
    antialias: true,
  })
  cleanup = () => {
    cancelled = true
    geometry.dispose()
    material.dispose()
    renderer.dispose()
    timer.dispose()
  }
  await renderer.init()
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace

  const device = (renderer.backend as unknown as WebGPUBackendWithDevice).device
  if (!device) return cleanup()

  // Initialize the Effekseer WebGPU runtime
  // Give Effekseer the GPUDevice created by Three.
  effekseer.setWebGPUDevice(device)
  // Load and initialize the WebAssembly runtime.
  await effekseer.initRuntime('/effekseer-runtime/Effekseer_WebGPU_Runtime.wasm')
  if (cancelled) return

  // Create a context
  // Create one Effekseer rendering context for this scene.
  const ctx = effekseer.createContext()
  // Initialize the context for external render-pass rendering.
  if (!ctx?.initExternal({
    instanceMaxCount: 20000,
    squareMaxCount: 20000,
  })) return cleanup()
  cleanup = () => {
    cancelled = true
    // Stop the currently playing effect instance.
    handle?.stop()
    // Stop all active effect instances in this context.
    ctx.stopAll()
    // Release the native Effekseer context resources.
    effekseer.releaseContext(ctx)
    geometry.dispose()
    material.dispose()
    renderer.dispose()
    timer.dispose()
  }

  // Bridge Three and Effekseer through the add-on pass.
  // `basic` would draw Effekseer in Three's main scene pass, which keeps normal depth
  // occlusion but does not support background capture for distortion.
  const effekseerPass = new EffekseerRenderPass(renderer, scene, camera, ctx, {
    mode: 'composite',
  })

  const resize = () => {
    const width = Math.max(1, canvas.clientWidth)
    const height = Math.max(1, canvas.clientHeight)
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    // Keep the Effekseer pass render size in sync with the canvas.
    effekseerPass.setSize(width, height, pixelRatio)
  }

  const render = (time: number) => {
    if (cancelled) return

    if (handle && !isHandleAlive(handle)) {
      handle = null
    }

    timer.update(time)

    const deltaFrames = Math.max(0, timer.getDelta() * 60)
    mesh.rotation.y += 0.01
    mesh.rotation.z += 0.01

    // Update and draw Effekseer through the add-on pass.
    effekseerPass.render(deltaFrames)
    window.requestAnimationFrame(render)
  }

  cleanup = () => {
    cancelled = true
    window.removeEventListener('resize', resize)
    window.removeEventListener('beforeunload', cleanup)
    // Stop the currently playing effect instance.
    handle?.stop()
    // Stop all active effect instances in this context.
    ctx.stopAll()
    // Release the native Effekseer context resources.
    effekseer.releaseContext(ctx)
    // Release the render-pass resources owned by the add-on.
    effekseerPass.dispose()
    geometry.dispose()
    material.dispose()
    renderer.dispose()
    timer.dispose()
  }

  // Load effect data
  // Register the effect under a string id so it can be loaded and played by name.
  ctx.registerEffects({
    blood: {
      path: effectUrl,
      scale: 1,
    },
  })

  resize()
  // Wait until the requested registered effect ids finish loading.
  // If called without ids, the managed-effect API resolves all registered effects.
  const loadedEffects = await ctx.whenEffectsReady(['blood'])
  if (cancelled) return

  // The managed-effect API loads asynchronously, so bail out if registration did not resolve to a ready effect.
  if (!loadedEffects.get('blood')) return cleanup()

  // Play the registered effect by id and keep its handle for cleanup.
  handle = ctx.playEffect('blood', 0, 0, 0)
  if (!handle) return cleanup()

  window.addEventListener('resize', resize)
  window.addEventListener('beforeunload', cleanup)

  // Main loop
  window.requestAnimationFrame(render)
}

void main().catch((error: unknown) => {
  console.error(error)
})
