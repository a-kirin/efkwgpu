import { useEffect, useRef } from 'react'
import './App.css'
import moonblastUrl from './pkmoves/moonblast/moonblast.efkwg?url'
import psychicUrl from './pkmoves/test.efkwgpk?url'
import shadowballUrl from './pkmoves/shadowball.efkwgpk?url'
import type { EffekseerContext, EffekseerHandle } from 'three-effekseer'
import { EFFEKSEER_RUNTIME_WASM_URL, ensureEffekseerRuntimeLoaded } from './lib/effekseerRuntime'

// Effect registry passed into Effekseer after the context is created.
const EFFECTS = {
  moonblast: moonblastUrl,
  psychic: psychicUrl,
  shadowball: shadowballUrl,
} as const



// Viewer-side ordering for keyboard cycling. Effekseer only sees the effect ids.
const EFFECT_IDS = ['moonblast', 'psychic', 'shadowball'] as const
// Camera values applied through the Effekseer camera/projection API on resize.
const DEFAULT_CAMERA = {
  fov: 45,
  near: 0.1,
  far: 100,
  eye: { x: 9, y: 4.5, z: 9 },
  target: { x: 0, y: 1, z: 0 },
  up: { x: 0, y: 1, z: 0 },
}
export default function ViewerCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    // The host owns the canvas and WebGPU device. Effekseer is attached to that environment.
    const canvas = canvasRef.current
    if (!canvas || !('gpu' in navigator)) {
      return
    }

    // Local viewer state kept for the lifetime of this mounted integration.
    let cancelled = false
    let frame = 0
    let lastFrameTime = performance.now()
    let device: GPUDevice | null = null
    let presentationContext: GPUCanvasContext | null = null
    let presentationFormat: GPUTextureFormat = 'bgra8unorm'
    let ctx: EffekseerContext | null = null
    let handle: EffekseerHandle | null = null
    let currentEffectIndex = 0
    let effekseerApi = window.effekseer ?? null

    // Reconfigure the host canvas surface and then push the matching camera state into Effekseer.
    const resize = () => {
      if (!canvas || !device || !presentationContext || !ctx) {
        return
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.max(1, Math.floor(canvas.clientWidth * dpr))
      const height = Math.max(1, Math.floor(canvas.clientHeight * dpr))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }

      presentationContext.configure({
        device,
        format: presentationFormat,
        alphaMode: 'opaque',
      })

      const aspect = Math.max(0.001, canvas.width / canvas.height)
      ctx.setProjectionPerspective(
        DEFAULT_CAMERA.fov,
        aspect,
        DEFAULT_CAMERA.near,
        DEFAULT_CAMERA.far
      )
      ctx.setCameraLookAt(
        DEFAULT_CAMERA.eye.x,
        DEFAULT_CAMERA.eye.y,
        DEFAULT_CAMERA.eye.z,
        DEFAULT_CAMERA.target.x,
        DEFAULT_CAMERA.target.y,
        DEFAULT_CAMERA.target.z,
        DEFAULT_CAMERA.up.x,
        DEFAULT_CAMERA.up.y,
        DEFAULT_CAMERA.up.z
      )
    }

    // The host render loop advances Effekseer once per frame and provides the external render pass.
    const render = () => {
      if (!ctx || !device || !presentationContext) {
        return
      }

      const now = performance.now()
      ctx.update(Math.max(0, ((now - lastFrameTime) / 1000) * 60))
      lastFrameTime = now

      const encoder = device.createCommandEncoder({ label: 'viewer-frame' })
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: presentationContext.getCurrentTexture().createView(),
            clearValue: { r: 0.027, g: 0.04, b: 0.07, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })

      ctx.drawExternal(pass, {
        colorFormat: presentationFormat,
        depthFormat: null,
        sampleCount: 1,
      })
      pass.end()
      device.queue.submit([encoder.finish()])

      frame = window.requestAnimationFrame(render)
    }

    // Playback stays id-based. The viewer does not hold raw effect refs.
    const playCurrentEffect = async () => {
      if (!ctx) {
        return
      }

      const effectId = EFFECT_IDS[currentEffectIndex]
      const loadedEffects = await ctx.whenEffectsReady([effectId])
      if (cancelled || !loadedEffects.get(effectId)) {
        throw new Error(`ViewerCanvas: ${effectId} failed to load.`)
      }

      handle?.stop()
      handle = ctx.playEffect(effectId, 0, 0, 0)
      if (!handle) {
        throw new Error(`ViewerCanvas: playEffect("${effectId}") returned null.`)
      }
    }

    // Input is viewer-specific. Effekseer only receives the final playEffect(id) call.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') {
        return
      }

      event.preventDefault()
      currentEffectIndex = (currentEffectIndex + 1) % EFFECT_IDS.length
      void playCurrentEffect().catch((error: unknown) => {
        console.error(error)
      })
    }

    // Boot order matters:
    // 1. create the host WebGPU environment
    // 2. bind that device into Effekseer
    // 3. initialize the Effekseer context in host-owned external-pass mode
    // 4. register and preload effects
    // 5. start playback and the host render loop
    void (async () => {
      await ensureEffekseerRuntimeLoaded()
      if (cancelled) {
        return
      }
      effekseerApi = window.effekseer ?? null
      if (!effekseerApi) {
        throw new Error('ViewerCanvas: Effekseer runtime did not initialize.')
      }

      // Adapter and canvas context belong to the host integration, not to Effekseer.
      const adapter = await navigator.gpu.requestAdapter()
      presentationContext = canvas.getContext('webgpu') as GPUCanvasContext | null
      if (!adapter || !presentationContext) {
        return
      }

      // Effekseer must render through the same GPUDevice used by the canvas surface.
      device = await adapter.requestDevice()
      if (cancelled) {
        return
      }

      // The runtime module is initialized once and then receives the host-owned WebGPU device.
      presentationFormat = navigator.gpu.getPreferredCanvasFormat()
      effekseerApi.setWebGPUDevice(device)
      await effekseerApi.initRuntime(EFFEKSEER_RUNTIME_WASM_URL)
      if (cancelled) {
        return
      }

      // Context creation is separate from effect registration so the host setup stays independent from assets.
      ctx = effekseerApi.createContext()
      if (!ctx?.initExternal({
        instanceMaxCount: 8000,
        squareMaxCount: 10000,
      })) {
        return
      }

      // Asset registration happens after init. The managed loader owns preload and id-based playback.
      ctx.registerEffects({
        moonblast: {
          path: EFFECTS.moonblast,
          scale: 1,
          enabled: true
        },
        psychic: {
          path: EFFECTS.psychic,
          scale: 1,
          enabled: true
        },
        shadowball: {
          path: EFFECTS.shadowball,
          scale: 1,
          enabled: true
        },
      })

      // Camera state is host-driven. Only the initial effect blocks startup; the others continue loading in the background.
      resize()
      const loadedEffects = await ctx.whenEffectsReady([EFFECT_IDS[0]])
      if (cancelled) {
        return
      }

      const loadedInitialEffect = loadedEffects.get(EFFECT_IDS[0])
      if (!loadedInitialEffect) {
        throw new Error(`ViewerCanvas: ${EFFECT_IDS[0]} failed to load.`)
      }

      // Once loading is complete, start playback and hand control to the host loop.
      await playCurrentEffect()
      window.addEventListener('keydown', handleKeyDown)
      window.addEventListener('resize', resize)
      frame = window.requestAnimationFrame(render)
    })().catch((error: unknown) => {
      console.error(error)
    })

    // The host tears down the frame loop and releases the Effekseer context when this integration unmounts.
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', resize)
      handle?.stop()
      ctx?.stopAll()
      effekseerApi?.releaseContext(ctx)
    }
  }, [])

  return <canvas ref={canvasRef} className="viewer-canvas" />
}
