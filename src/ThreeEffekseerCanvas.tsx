import { useEffect, useRef } from 'react'
import * as THREE from 'three/webgpu'
import './App.css'
import moonblastUrl from './pkmoves/test.efkwgpk?url'
import {
  EffekseerRenderPass,
  type EffekseerContext,
  type EffekseerHandle,
} from 'three-effekseer'
import { EFFEKSEER_RUNTIME_WASM_URL, ensureEffekseerRuntimeLoaded } from './lib/effekseerRuntime'

const CAMERA = {
  fov: 45,
  near: 0.1,
  far: 100,
  eye: { x: 9, y: 4.5, z: 9 },
  target: { x: 0, y: 1, z: 0 },
  up: { x: 0, y: 1, z: 0 },
}

type WebGPUBackendWithDevice = {
  device: GPUDevice | null
}

export default function ThreeEffekseerCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !('gpu' in navigator)) {
      return
    }

    let cancelled = false
    let frame = 0
    let lastFrameTime = performance.now()
    let renderer: THREE.WebGPURenderer | null = null
    let effekseerPass: EffekseerRenderPass | null = null
    let scene: THREE.Scene | null = null
    let camera: THREE.PerspectiveCamera | null = null
    let mesh: THREE.Mesh | null = null
    let geometry: THREE.TorusKnotGeometry | null = null
    let material: THREE.MeshStandardMaterial | null = null
    let ctx: EffekseerContext | null = null
    let handle: EffekseerHandle | null = null
    let effekseerApi = window.effekseer ?? null

    const resize = () => {
      if (!effekseerPass) {
        return
      }

      const width = Math.max(1, canvas.clientWidth)
      const height = Math.max(1, canvas.clientHeight)
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      effekseerPass.setSize(width, height, pixelRatio)
    }

    const render = (time: number) => {
      if (!effekseerPass || !mesh) {
        return
      }

      const deltaFrames = Math.max(0, ((time - lastFrameTime) / 1000) * 60)
      lastFrameTime = time

      const seconds = time * 0.001
      mesh.rotation.x = seconds * 0.35
      mesh.rotation.y = seconds * 0.6

      effekseerPass.render(deltaFrames)
      frame = window.requestAnimationFrame(render)
    }

    void (async () => {
      await ensureEffekseerRuntimeLoaded()
      if (cancelled) {
        return
      }
      effekseerApi = window.effekseer ?? null
      if (!effekseerApi) {
        throw new Error('ThreeEffekseerCanvas: Effekseer runtime did not initialize.')
      }

      renderer = new THREE.WebGPURenderer({
        canvas,
        alpha: false,
        antialias: true,
      })
      await renderer.init()
      if (cancelled) {
        renderer.dispose()
        return
      }

      const device = (renderer.backend as unknown as WebGPUBackendWithDevice).device
      if (!device) {
        return
      }

      scene = new THREE.Scene()
      const clearColor = new THREE.Color('#07101c')
      scene.background = clearColor

      camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far)
      camera.position.set(CAMERA.eye.x, CAMERA.eye.y, CAMERA.eye.z)
      camera.up.set(CAMERA.up.x, CAMERA.up.y, CAMERA.up.z)
      camera.lookAt(CAMERA.target.x, CAMERA.target.y, CAMERA.target.z)

      const ambientLight = new THREE.AmbientLight('#7f8fb3', 1.3)
      const keyLight = new THREE.DirectionalLight('#ffffff', 2.4)
      keyLight.position.set(4, 6, 5)
      const rimLight = new THREE.DirectionalLight('#7dc4ff', 1.1)
      rimLight.position.set(-5, 2, -3)

      geometry = new THREE.TorusKnotGeometry(1.1, 0.34, 192, 32)
      material = new THREE.MeshStandardMaterial({
        color: '#9ad1ff',
        metalness: 0.18,
        roughness: 0.34,
      })
      mesh = new THREE.Mesh(geometry, material)

      scene.add(ambientLight, keyLight, rimLight, mesh)

      effekseerApi.setWebGPUDevice(device)
      await effekseerApi.initRuntime(EFFEKSEER_RUNTIME_WASM_URL)
      if (cancelled) {
        return
      }

      ctx = effekseerApi.createContext()
      if (!ctx?.initExternal({
        instanceMaxCount: 8000,
        squareMaxCount: 10000,
      })) {
        return
      }

      effekseerPass = new EffekseerRenderPass(renderer, scene, camera, ctx, {
        mode: 'composite',
      })

      ctx.registerEffects({
        moonblast: {
          path: moonblastUrl,
          scale: 1,
        },
      })

      resize()
      const loadedEffects = await ctx.whenEffectsReady(['moonblast'])
      if (cancelled) {
        return
      }

      const loadedMoonblast = loadedEffects.get('moonblast')
      if (!loadedMoonblast) {
        throw new Error('ThreeEffekseerCanvas: moonblast failed to load.')
      }

      handle = ctx.playEffect('moonblast', 0, 0, 0)
      if (!handle) {
        throw new Error('ThreeEffekseerCanvas: playEffect("moonblast") returned null.')
      }

      window.addEventListener('resize', resize)
      frame = window.requestAnimationFrame(render)
    })().catch((error: unknown) => {
      console.error(error)
    })

    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      handle?.stop()
      ctx?.stopAll()
      effekseerApi?.releaseContext(ctx)
      effekseerPass?.dispose()
      geometry?.dispose()
      material?.dispose()
      renderer?.dispose()
    }
  }, [])

  return <canvas ref={canvasRef} className="viewer-canvas" />
}
