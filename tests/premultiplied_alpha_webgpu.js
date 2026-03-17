import * as THREE from 'three/webgpu'
import { EffekseerRenderPass } from 'three-effekseer'

const canvas = document.getElementById('canvas')
const effekseerApi = window.effekseer

if (!canvas || !effekseerApi || !('gpu' in navigator)) {
  console.warn('WebGPU runtime no disponible en este navegador/contexto.')
} else {
  const renderer = new THREE.WebGPURenderer({
    canvas,
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
  })
  renderer.setSize(canvas.width, canvas.height)
  renderer.setClearColor(0x000000, 0.01)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30.0, canvas.width / canvas.height, 1, 1000)
  camera.position.set(20, 20, 20)
  camera.lookAt(new THREE.Vector3(0, 0, 0))

  const clock = new THREE.Clock()
  let pass = null

  const resize = () => {
    if (!pass) return
    const width = Math.max(1, canvas.clientWidth || canvas.width)
    const height = Math.max(1, canvas.clientHeight || canvas.height)
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    pass.setSize(width, height, pixelRatio)
  }

  const loop = () => {
    if (pass) {
      pass.render(Math.max(0, clock.getDelta() * 60.0) || 1.0)
    }
    requestAnimationFrame(loop)
  }

  const main = async () => {
    await renderer.init()
    const device = renderer.backend?.device
    if (!device) {
      throw new Error('WebGPU device no disponible desde Three.js')
    }

    effekseerApi.setWebGPUDevice(device)
    await effekseerApi.initRuntime('/effekseer-runtime/Effekseer_WebGPU_Runtime.wasm')

    const context = effekseerApi.createContext()
    if (!context) {
      throw new Error('createContext() devolvio null')
    }

    const settings = {
      instanceMaxCount: 20000,
      squareMaxCount: 20000,
      externalRenderPass: true,
      enablePremultipliedAlpha: true,
    }

    const initialized = typeof context.initExternal === 'function'
      ? context.initExternal(settings)
      : context.init(canvas, settings)

    if (!initialized) {
      throw new Error('context.init fallo')
    }

    pass = new EffekseerRenderPass(renderer, scene, camera, context, { mode: 'composite' })
    resize()
    window.addEventListener('resize', resize)

    const effect = context.loadEffect('Resources/Arrow1.efkwg', 1.0, () => {
      const handle = context.play(effect)
      handle?.setLocation?.(0, 0, 0)
    })

    loop()
  }

  main().catch((err) => {
    console.error(err)
  })
}
