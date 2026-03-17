import * as THREE from 'three/webgpu'
import { EffekseerRenderPass } from 'three-effekseer'

const canvas = document.getElementById('canvas')
const effekseerApi = window.effekseer

if (!canvas || !effekseerApi || !('gpu' in navigator)) {
  console.warn('WebGPU runtime no disponible en este navegador/contexto.')
} else {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
  const clock = new THREE.Clock()
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30.0, canvas.width / canvas.height, 1, 1000)
  camera.position.set(20, 20, 20)
  camera.lookAt(new THREE.Vector3(0, 0, 0))

  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 })
  const cube = new THREE.Mesh(geometry, material)
  scene.add(cube)

  const grid = new THREE.GridHelper(20, 10, 0xffffff, 0xffffff)
  scene.add(grid)

  let pass = null

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

    cube.rotation.y += 0.01
    cube.rotation.z += 0.01
    pass.render(Math.max(0, clock.getDelta() * 60.0) || 1.0)
    requestAnimationFrame(renderLoop)
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

    renderLoop()
  }

  main().catch((err) => {
    console.error(err)
  })
}
