import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import './App.css'
import testUrl from './pkmoves/test.efkwgpk?url'
import shadowballUrl from './pkmoves/shadowball.efkwgpk?url'
import aurahdrUrl from './pkmoves/aurahdr.efkwgpk?url'
import bloodUrl from './pkmoves/blood.efkwgpk?url'
import {
  EffekseerRenderPass,
  type EffekseerContext,
  type EffekseerHandle,
} from 'three-effekseer'
import {
  convertToEfwgpk,
  type ConvertedPackage,
  type ConverterInputFile,
} from './efwgpkConverter'
import { convertToEfwgpkNative } from './nativeEfwgpkConverter'

type SampleEffect = {
  id: string
  label: string
  path: string
  note: string
}

type WebGPUBackendWithDevice = {
  device: GPUDevice | null
}

type ExtendedEffekseerContext = EffekseerContext & {
  unregisterEffects?: (ids?: string[] | string) => void
  loadEffect?: (
    data: string | ArrayBuffer | Uint8Array,
    scale?: number,
    onload?: () => void,
    onerror?: (message: string, path: string) => void
  ) => ExtendedEffekseerEffect | null
  releaseEffect?: (effect: ExtendedEffekseerEffect | null) => void
  play?: (effect: ExtendedEffekseerEffect | null, x?: number, y?: number, z?: number) => ExtendedEffekseerHandle | null
}

type ExtendedEffekseerHandle = EffekseerHandle & {
  setPaused?: (paused: boolean) => void
  sendTrigger?: (index: number) => void
  exists?: boolean
}

type ExtendedEffekseerEffect = {
  isLoaded?: boolean
  nativeptr?: number
  resources?: Array<{
    path?: string
    isLoaded?: boolean
    buffer?: ArrayBuffer | Uint8Array | null
  }>
}

type RuntimeState = {
  ctx: ExtendedEffekseerContext | null
  renderer: THREE.WebGPURenderer | null
  pass: EffekseerRenderPass | null
  handle: ExtendedEffekseerHandle | null
  directEffect: ExtendedEffekseerEffect | null
  builtInEffects: Map<string, ExtendedEffekseerEffect>
  activeEffectId: string | null
}


type IconProps = {
  size?: number
}

const IconPlayFilled = ({ size = 16 }: IconProps) => (
  <svg className="ctrl-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <path d="M4 2.4v11.2L13 8z" />
  </svg>
)

const IconPauseFilled = ({ size = 16 }: IconProps) => (
  <svg className="ctrl-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <path d="M3.2 2.4h3.8v11.2H3.2zM9 2.4h3.8v11.2H9z" />
  </svg>
)

const IconStopFilled = ({ size = 16 }: IconProps) => (
  <svg className="ctrl-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <path d="M3 3h10v10H3z" />
  </svg>
)

const IconReplayFilled = ({ size = 16 }: IconProps) => (
  <svg className="ctrl-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <path d="M7.9 1.7A6.3 6.3 0 0 0 2.2 5h2.2a4.4 4.4 0 1 1-.2 5.8l1.8-1.1H1.6v4.3l1.7-1.1A6.3 6.3 0 1 0 8 1.7h-.1z" />
  </svg>
)

const IconNextFilled = ({ size = 16 }: IconProps) => (
  <svg className="ctrl-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <path d="M2.2 2.4v11.2L8 8zm6.5 0v11.2L14.5 8z" />
  </svg>
)

const IconChevronLeftFilled = ({ size = 16 }: IconProps) => (
  <svg className="ctrl-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <path d="M10.8 2.3 4.6 8l6.2 5.7z" />
  </svg>
)

const IconChevronRightFilled = ({ size = 16 }: IconProps) => (
  <svg className="ctrl-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <path d="m5.2 2.3 6.2 5.7-6.2 5.7z" />
  </svg>
)


const SAMPLE_EFFECTS: SampleEffect[] = [
  { id: 'test', label: 'test.efkwgpk', path: testUrl, note: 'baseline package' },
  { id: 'shadowball', label: 'shadowball.efkwgpk', path: shadowballUrl, note: 'distortion sample' },
  { id: 'aurahdr', label: 'aurahdr.efkwgpk', path: aurahdrUrl, note: 'hdr aura' },
  { id: 'blood', label: 'blood.efkwgpk', path: bloodUrl, note: 'blood splash' },
]

const BUILTIN_IDS = SAMPLE_EFFECTS.map((effect) => effect.id)
const TRIGGER_INDICES = [0, 1, 2, 3] as const
const CONVERTED_PREVIEW_SCALE = 1
const SAMPLE_LOOKUP = new Map(SAMPLE_EFFECTS.map((effect) => [effect.id, effect]))
const BUILTIN_REGISTRY = Object.fromEntries(
  SAMPLE_EFFECTS.map((effect) => [
    effect.id,
    {
      path: effect.path,
      scale: 1,
    },
  ])
)

const createRuntimeState = (): RuntimeState => ({
  ctx: null,
  renderer: null,
  pass: null,
  handle: null,
  directEffect: null,
  builtInEffects: new Map<string, ExtendedEffekseerEffect>(),
  activeEffectId: null,
})

const hasManagedEffectsApi = (ctx: ExtendedEffekseerContext | null | undefined) => (
  !!ctx &&
  typeof ctx.registerEffects === 'function' &&
  typeof ctx.whenEffectsReady === 'function' &&
  typeof ctx.playEffect === 'function'
)

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const getBufferByteLength = (buffer: ArrayBuffer | Uint8Array | null | undefined): number => {
  if (!buffer) return 0
  if (buffer instanceof ArrayBuffer) return buffer.byteLength
  if (buffer instanceof Uint8Array) return buffer.byteLength
  return 0
}

const getBufferHeadHex = (buffer: ArrayBuffer | Uint8Array | null | undefined, count = 8): string => {
  if (!buffer) return ''
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (view.byteLength === 0) return ''
  const bytes = view.subarray(0, Math.min(count, view.byteLength))
  return Array.from(bytes).map((v) => v.toString(16).padStart(2, '0')).join('')
}

type PackageSummary = {
  entries: number
  png: number
  models: number
  materials: number
  sounds: number
}

const summarizeEfwgpk = (bytes: Uint8Array): PackageSummary | null => {
  if (bytes.byteLength < 64) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = String.fromCharCode(
    bytes[0] ?? 0,
    bytes[1] ?? 0,
    bytes[2] ?? 0,
    bytes[3] ?? 0,
    bytes[4] ?? 0,
    bytes[5] ?? 0,
    bytes[6] ?? 0,
    bytes[7] ?? 0
  )
  if (magic !== 'EFWGPKG1') return null

  const entryCount = view.getUint32(20, true)
  const entrySize = view.getUint32(24, true)
  const entriesOffset = view.getUint32(28, true)
  if (entryCount <= 0 || entrySize <= 0) {
    return { entries: 0, png: 0, models: 0, materials: 0, sounds: 0 }
  }

  let png = 0
  let models = 0
  let materials = 0
  let sounds = 0

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = entriesOffset + i * entrySize
    if (entryOffset + 16 > bytes.byteLength) break
    const pathOffset = view.getUint32(entryOffset + 8, true)
    const pathLength = view.getUint32(entryOffset + 12, true)
    if (pathOffset + pathLength > bytes.byteLength || pathLength <= 0) continue
    const pathBytes = bytes.subarray(pathOffset, pathOffset + pathLength)
    const path = new TextDecoder().decode(pathBytes).toLowerCase()
    if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.dds')) png++
    if (path.endsWith('.efkmodel') || path.endsWith('.mqo')) models++
    if (path.endsWith('.efkmat') || path.endsWith('.efkmatd')) materials++
    if (path.endsWith('.wav') || path.endsWith('.ogg') || path.endsWith('.mp3')) sounds++
  }

  return { entries: entryCount, png, models, materials, sounds }
}

const isHandleAlive = (handle: ExtendedEffekseerHandle | null | undefined): boolean => {
  if (!handle) return false
  return handle.exists !== false
}

const requiresDependencyFolder = (fileName: string): boolean => {
  const lower = fileName.toLowerCase()
  return lower.endsWith('.efkefc')
}

export default function EffekseerConverterCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cubeRef = useRef<THREE.Mesh | null>(null)
  const gridRef = useRef<THREE.GridHelper | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const sourceInputRef = useRef<HTMLInputElement | null>(null)
  const depsInputRef = useRef<HTMLInputElement | null>(null)
  const runtimeRef = useRef<RuntimeState>(createRuntimeState())

  const [runtimeReady, setRuntimeReady] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [activeEffectId, setActiveEffectId] = useState('')
  const [playback, setPlayback] = useState<'stopped' | 'playing' | 'paused'>('stopped')
  const [error, setError] = useState('')
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [depsFiles, setDepsFiles] = useState<File[]>([])
  const [showDepsPrompt, setShowDepsPrompt] = useState(false)
  const [depsPromptSource, setDepsPromptSource] = useState('')
  const [pendingAutoConvert, setPendingAutoConvert] = useState(false)
  const [loadingMessage, setLoadingMessage] = useState('')
  const [converting, setConverting] = useState(false)
  const [showSceneCube, setShowSceneCube] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showStats, setShowStats] = useState(false)
  const [bgColor, setBgColor] = useState('#111113')
  const [gridColor, setGridColor] = useState('#ffffff')
  const [showConvertedList, setShowConvertedList] = useState(true)
  const [showLibraryList, setShowLibraryList] = useState(true)
  const [showSamplesList, setShowSamplesList] = useState(true)
  const [convertedList, setConvertedList] = useState<Array<ConvertedPackage>>([])
  const [convertedPackage, setConvertedPackage] = useState<ConvertedPackage | null>(null)
  const [, setConverterStatus] = useState('Choose or drop .efkefc, .efkpkg, or .efkwgpk')
  
  // Credits System
  const [credits, setCredits] = useState(5)
  const [unlockedDownloads, setUnlockedDownloads] = useState<Set<string>>(new Set())
  const [showUnlockModal, setShowUnlockModal] = useState<ConvertedPackage | null>(null)
  const [showProfileMenu, setShowProfileMenu] = useState(false)

  const useNativeConverter = true
  const injectMeshNative = true

  const appendLog = useCallback((message: string) => {
    if (!message) return
    console.info(`[EffekseerConverter] ${message}`)
  }, [])

  const clearConvertedRegistration = useCallback(() => {
    const runtime = runtimeRef.current
    if (runtime.ctx?.releaseEffect && runtime.directEffect) {
      try {
        runtime.ctx.releaseEffect(runtime.directEffect)
      } catch {
        // Ignore stale release failures during teardown.
      }
    }
    runtime.directEffect = null
  }, [])

  const releaseBuiltInEffects = useCallback(() => {
    const runtime = runtimeRef.current
    if (!runtime.ctx?.releaseEffect || runtime.builtInEffects.size === 0) return
    for (const effect of runtime.builtInEffects.values()) {
      try {
        runtime.ctx.releaseEffect(effect)
      } catch {
        // Ignore stale release failures during teardown.
      }
    }
    runtime.builtInEffects.clear()
  }, [])

  const playDirectEffect = useCallback((
    effect: ExtendedEffekseerEffect,
    effectId: string,
    label: string
  ) => {
    const runtime = runtimeRef.current
    const ctx = runtime.ctx
    if (!ctx?.play) return false

    runtime.handle?.stop()
    ctx.stopAll()

    const handle = ctx.play(effect, 0, 0, 0)
    if (!handle) {
      setPlayback('stopped')
      setError(`play("${label}") returned null.`)
      appendLog(`play("${label}") returned null.`)
      return false
    }

    runtime.handle = handle
    runtime.directEffect = effect
    runtime.activeEffectId = effectId
    setActiveEffectId(effectId)
    setPlayback('playing')
    setError('')
    appendLog(`Playing ${label}`)
    return true
  }, [appendLog])

  const playRegisteredEffect = useCallback(async (effectId: string) => {
    const runtime = runtimeRef.current
    const ctx = runtime.ctx
    if (!ctx) return false

    try {
      clearConvertedRegistration()
      runtime.handle?.stop()
      ctx.stopAll()

      let handle: ExtendedEffekseerHandle | null = null
      if (hasManagedEffectsApi(ctx)) {
        const loadedEffects = await ctx.whenEffectsReady([effectId])
        if (!loadedEffects.get(effectId)) {
          throw new Error(`Effect "${effectId}" failed to load.`)
        }
        handle = ctx.playEffect(effectId, 0, 0, 0) as ExtendedEffekseerHandle | null
        if (!handle) {
          throw new Error(`playEffect("${effectId}") returned null.`)
        }
      } else {
        const sample = SAMPLE_LOOKUP.get(effectId)
        if (!sample) {
          throw new Error(`Unknown sample id: ${effectId}`)
        }
        if (!ctx.loadEffect || !ctx.play) {
          throw new Error('Runtime context does not expose loadEffect()/play() APIs.')
        }

        let effect = runtime.builtInEffects.get(effectId) ?? null
        if (!effect) {
          const response = await fetch(sample.path)
          if (!response.ok) {
            throw new Error(`Failed to fetch sample bytes (${response.status}) for ${sample.label}`)
          }
          const sampleBytes = await response.arrayBuffer()
          effect = await new Promise<ExtendedEffekseerEffect>((resolve, reject) => {
            let requestedEffect: ExtendedEffekseerEffect | null = null
            requestedEffect = ctx.loadEffect!(
              sampleBytes,
              1,
              () => resolve(requestedEffect!),
              (message, path) => reject(new Error(path ? `${message} (${path})` : message))
            )
            if (!requestedEffect) {
              reject(new Error(`loadEffect(bytes for "${sample.label}") returned null.`))
            }
          })
          runtime.builtInEffects.set(effectId, effect)
        }

        if (!effect.isLoaded) {
          throw new Error(`Effect "${sample.label}" did not finish loading.`)
        }
        handle = ctx.play(effect, 0, 0, 0) as ExtendedEffekseerHandle | null
        if (!handle) {
          throw new Error(`play("${sample.label}") returned null.`)
        }
      }

      runtime.handle = handle
      runtime.activeEffectId = effectId
      setActiveEffectId(effectId)
      setPlayback('playing')
      setError('')
      appendLog(`Playing ${SAMPLE_LOOKUP.get(effectId)?.label ?? effectId}`)
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setPlayback('stopped')
      setError(message)
      appendLog(message)
      return false
    }
  }, [appendLog, clearConvertedRegistration])

  const loadConvertedPreview = useCallback(async (pkg: ConvertedPackage) => {
    const runtime = runtimeRef.current
    const ctx = runtime.ctx
    if (!ctx?.loadEffect) return

    clearConvertedRegistration()
    runtime.handle?.stop()
    ctx.stopAll()

    const effect = await new Promise<ExtendedEffekseerEffect>((resolve, reject) => {
      let requestedEffect: ExtendedEffekseerEffect | null = null
      requestedEffect = ctx.loadEffect!(
        toArrayBuffer(pkg.bytes),
        CONVERTED_PREVIEW_SCALE,
        () => resolve(requestedEffect!),
        (message, path) => reject(new Error(path ? `${message} (${path})` : message))
      )
      if (!requestedEffect) {
        reject(new Error('loadEffect(bytes) returned null.'))
      }
    })

    if (!effect.isLoaded) {
      throw new Error(`Converted effect "${pkg.outputName}" did not finish loading.`)
    }

    const resources = Array.isArray(effect.resources) ? effect.resources : []
    if (resources.length > 0) {
      const requested = resources
        .map((entry) => entry?.path || '')
        .filter((value) => value.length > 0)
      const missing = resources
        .filter((entry) => entry?.isLoaded && !entry?.buffer)
        .map((entry) => entry?.path || '(unknown)')
      appendLog(
        `Package resource status: total=${resources.length} loaded=${resources.length - missing.length} missing=${missing.length}`
      )
      appendLog(`Package resource requested list: ${requested.join(', ')}`)
      if (missing.length > 0) {
        appendLog(`Package resource missing list: ${missing.join(', ')}`)
      }
      for (const entry of resources) {
        const path = entry?.path || '(unknown)'
        const loaded = entry?.isLoaded ? 'loaded' : 'pending'
        const buffer = entry?.buffer ?? null
        const bytes = getBufferByteLength(buffer)
        const head = getBufferHeadHex(buffer)
        appendLog(`Package resource detail: ${path} | ${loaded} | bytes=${bytes} | head=${head}`)
      }
    } else {
      appendLog('Package resource status: effect requested 0 external resources.')
    }

    setConverterStatus(`Preview ready: ${pkg.outputName}`)
    appendLog(`Loaded ${pkg.outputName} from bytes`)
    playDirectEffect(effect, 'converted-preview', pkg.outputName)
  }, [appendLog, clearConvertedRegistration, playDirectEffect])

  useEffect(() => {
    const input = depsInputRef.current
    if (!input) return
    input.setAttribute('webkitdirectory', '')
    input.setAttribute('directory', '')
  }, [])

  useEffect(() => {
    if (cubeRef.current) {
      cubeRef.current.visible = showSceneCube
    }
  }, [showSceneCube])

  useEffect(() => {
    const grid = gridRef.current
    if (grid) grid.visible = showGrid
  }, [showGrid])

  useEffect(() => {
    const s = sceneRef.current
    if (s) s.background = new THREE.Color(bgColor)
  }, [bgColor])

  useEffect(() => {
    const grid = gridRef.current
    if (grid && !Array.isArray(grid.material)) {
      grid.material.vertexColors = false
      grid.material.color.set(gridColor)
      grid.material.needsUpdate = true
    }
  }, [gridColor])

  useEffect(() => {
    if (!showStats) {
      const existing = document.getElementById('three-stats')
      if (existing) existing.remove()
      return
    }
    let stats: { dom: HTMLElement; update: () => void } | null = null
    let raf = 0
    import('three/addons/libs/stats.module.js').then((mod) => {
      const StatsImpl = mod.default
      stats = new StatsImpl()
      stats!.dom.id = 'three-stats'
      stats!.dom.style.position = 'fixed'
      stats!.dom.style.bottom = '8px'
      stats!.dom.style.left = '8px'
      stats!.dom.style.top = 'auto'
      document.body.appendChild(stats!.dom)
      const loop = () => {
        stats!.update()
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    })
    return () => {
      cancelAnimationFrame(raf)
      const el = document.getElementById('three-stats')
      if (el) el.remove()
    }
  }, [showStats])

  useEffect(() => {
    const canvas = canvasRef.current
    const effekseer = window.effekseer
    if (!canvas || !('gpu' in navigator) || !effekseer) {
      setError('WebGPU runtime scripts are not available in this page.')
      return
    }

    let cancelled = false
    let frame = 0
    const timer = new THREE.Timer()
    timer.connect(document)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(bgColor)
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(9, 4.5, 9)
    camera.up.set(0, 1, 0)
    camera.lookAt(0, 1, 0)

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.target.set(0, 1, 0)
    controls.update()

    const grid = new THREE.GridHelper(20, 10, 0xffffff, 0xffffff)
    const geometry = new THREE.BoxGeometry(2, 2, 2)
    const material = new THREE.MeshBasicMaterial({ color: '#cc4c4c' })
    const cube = new THREE.Mesh(geometry, material)
    cube.visible = showSceneCube
    cubeRef.current = cube
    gridRef.current = grid
    controlsRef.current = controls
    scene.add(grid, cube)

    const renderer = new THREE.WebGPURenderer({
      canvas,
      alpha: false,
      antialias: true,
    })

    runtimeRef.current = {
      ...runtimeRef.current,
      renderer,
    }

    const resize = () => {
      const pass = runtimeRef.current.pass
      if (!pass) return

      const width = Math.max(1, canvas.clientWidth)
      const height = Math.max(1, canvas.clientHeight)
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
      renderer.setPixelRatio(pixelRatio)
      pass.setSize(width, height, pixelRatio)
    }

    const resizeObserver = new ResizeObserver(() => resize())
    resizeObserver.observe(canvas.parentElement || canvas)

    const render = (time: number) => {
      if (cancelled) return

      const pass = runtimeRef.current.pass
      if (!pass) return

      const handle = runtimeRef.current.handle
      if (handle && !isHandleAlive(handle)) {
        runtimeRef.current.handle = null
        setPlayback((prev) => (prev === 'stopped' ? prev : 'stopped'))
      }

      timer.update(time)
      if (cube.visible) {
        cube.rotation.y += 0.01
        cube.rotation.z += 0.01
      }
      controls.update()
      pass.render(Math.max(0, timer.getDelta() * 60))
      frame = window.requestAnimationFrame(render)
    }

    const disposeGrid = () => {
      grid.geometry.dispose()
      if (Array.isArray(grid.material)) {
        for (const entry of grid.material) {
          entry.dispose()
        }
        return
      }
      grid.material.dispose()
    }

    const cleanup = () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      resizeObserver.disconnect()
      clearConvertedRegistration()
      releaseBuiltInEffects()

      const runtime = runtimeRef.current
      runtime.handle?.stop()
      runtime.ctx?.stopAll()
      effekseer.releaseContext(runtime.ctx)
      runtime.pass?.dispose()
      geometry.dispose()
      material.dispose()
      disposeGrid()
      controls.dispose()
      renderer.dispose()
      timer.dispose()
      cubeRef.current = null

      runtimeRef.current = createRuntimeState()
      setRuntimeReady(false)
      setPlayback('stopped')
    }

    void (async () => {
      try {
        appendLog('Creating WebGPU renderer.')
        await renderer.init()
        if (cancelled) {
          cleanup()
          return
        }

        const device = (renderer.backend as unknown as WebGPUBackendWithDevice).device
        if (!device) {
          throw new Error('Three WebGPU backend did not expose a GPUDevice.')
        }

        appendLog('Initializing Effekseer runtime.')
        effekseer.setWebGPUDevice(device)
        await effekseer.initRuntime('/effekseer-runtime/Effekseer_WebGPU_Runtime.wasm')
        ;(effekseer as unknown as { setLogEnabled?: (flag: boolean) => void }).setLogEnabled?.(true)
        appendLog('Effekseer runtime native log enabled.')
        if (cancelled) {
          cleanup()
          return
        }

        const ctx = effekseer.createContext() as ExtendedEffekseerContext | null
        if (!ctx) {
          throw new Error('Effekseer createContext() returned null.')
        }

        const settings = {
          instanceMaxCount: 20000,
          squareMaxCount: 20000,
          externalRenderPass: true,
        }

        const initialized = typeof ctx.initExternal === 'function'
          ? ctx.initExternal(settings)
          : ctx.init(canvas, settings)

        if (!initialized) {
          throw new Error('Effekseer context initialization failed.')
        }

        const pass = new EffekseerRenderPass(renderer, scene, camera, ctx, {
          mode: 'composite',
        })

        runtimeRef.current = {
          ...runtimeRef.current,
          ctx,
          pass,
        }

        if (hasManagedEffectsApi(ctx)) {
          appendLog('Registering built-in .efkwgpk samples.')
          ctx.registerEffects(BUILTIN_REGISTRY)
        } else {
          appendLog('Managed registry API not available; using direct loadEffect() mode for built-ins.')
        }
        resize()
        setRuntimeReady(true)
        setConverterStatus('Runtime ready. Choose a built-in sample or load a converted package.')
        window.addEventListener('resize', resize)

        frame = window.requestAnimationFrame(render)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        appendLog(message)
        cleanup()
      }
    })()

    return cleanup
  }, [appendLog, clearConvertedRegistration, playRegisteredEffect, releaseBuiltInEffects])

  const selectSample = useCallback((effectId: string) => {
    void playRegisteredEffect(effectId)
  }, [playRegisteredEffect])

  const togglePlayback = useCallback(() => {
    const runtime = runtimeRef.current
    const handle = runtime.handle

    if (!runtime.activeEffectId) return

    if (handle && !isHandleAlive(handle)) {
      runtime.handle = null
      setPlayback('stopped')
    }

    if (playback === 'playing' && isHandleAlive(handle) && handle?.setPaused) {
      handle.setPaused(true)
      setPlayback('paused')
      appendLog('Paused current effect.')
      return
    }

    if (playback === 'paused' && isHandleAlive(handle) && handle?.setPaused) {
      handle.setPaused(false)
      setPlayback('playing')
      appendLog('Resumed current effect.')
      return
    }

    if (runtime.activeEffectId === 'converted-preview' && runtime.directEffect) {
      playDirectEffect(runtime.directEffect, 'converted-preview', convertedPackage?.outputName ?? 'converted preview')
      return
    }

    void playRegisteredEffect(runtime.activeEffectId)
  }, [appendLog, convertedPackage?.outputName, playback, playDirectEffect, playRegisteredEffect])

  const replayEffect = useCallback(() => {
    const runtime = runtimeRef.current
    const effectId = runtime.activeEffectId
    if (!effectId) return
    if (effectId === 'converted-preview' && runtime.directEffect) {
      playDirectEffect(runtime.directEffect, 'converted-preview', convertedPackage?.outputName ?? 'converted preview')
      return
    }
    void playRegisteredEffect(effectId)
  }, [convertedPackage?.outputName, playDirectEffect, playRegisteredEffect])

  const stopEffect = useCallback(() => {
    const runtime = runtimeRef.current
    runtime.handle?.stop()
    runtime.ctx?.stopAll()
    runtime.handle = null
    setPlayback('stopped')
    appendLog('Stopped all effect playback.')
  }, [appendLog])

  const playNext = useCallback(() => {
    if (activeEffectId === 'converted-preview' && convertedPackage) {
      if (convertedList.length > 0) {
        const currentIndex = convertedList.findIndex((item) => item.outputName === convertedPackage.outputName)
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % convertedList.length : 0
        const nextItem = convertedList[nextIndex]
        setConvertedPackage(nextItem)
        void loadConvertedPreview(nextItem)
      }
      return
    }

    const currentIndex = BUILTIN_IDS.indexOf(activeEffectId)
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % BUILTIN_IDS.length : 0
    void playRegisteredEffect(BUILTIN_IDS[nextIndex])
  }, [activeEffectId, playRegisteredEffect, convertedPackage, convertedList, loadConvertedPreview])

  const triggerEffect = useCallback((index: number) => {
    const handle = runtimeRef.current.handle
    if (!handle || handle.exists === false || !handle.sendTrigger) {
      setError('Current effect does not support trigger in this state.')
      return
    }
    handle.sendTrigger(index)
    appendLog(`Trigger ${index} sent.`)
  }, [appendLog])

  const openDepsPicker = useCallback(() => {
    const input = depsInputRef.current
    if (!input) return
    input.value = ''
    input.click()
  }, [])

  const requestDepsFolder = useCallback((sourceName: string, options?: { openPicker?: boolean }) => {
    setDepsPromptSource(sourceName)
    setShowDepsPrompt(true)
    setLoadingMessage('')
    setError('')
    setConverterStatus(`"${sourceName}" requires a dependency folder (Texture/Model/Material/Sound).`)
    appendLog(`Dependency folder required for ${sourceName}.`)
    if (options?.openPicker) {
      openDepsPicker()
    }
  }, [appendLog, openDepsPicker])

  const handleSourceChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null
    setSourceFile(nextFile)
    setDepsFiles([])
    setConvertedPackage(null)
    setPendingAutoConvert(false)
    setConverterStatus(nextFile ? `Source: ${nextFile.name}` : 'Choose a source effect first.')
    if (nextFile && requiresDependencyFolder(nextFile.name)) {
      requestDepsFolder(nextFile.name, { openPicker: true })
    } else {
      setShowDepsPrompt(false)
      setDepsPromptSource('')
      setLoadingMessage('')
      setPendingAutoConvert(!!nextFile)
    }
    if (sourceInputRef.current) {
      sourceInputRef.current.value = ''
    }
  }, [requestDepsFolder])

  const handleDepsChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    setDepsFiles(files)
    if (files.length > 0) {
      setShowDepsPrompt(false)
      setLoadingMessage('')
      setError('')
      setConverterStatus(`Resources selected: ${files.length} files`)
      appendLog(`Resources selected for ${sourceFile?.name ?? depsPromptSource}: ${files.length} files.`)
      if (sourceFile && requiresDependencyFolder(sourceFile.name)) {
        setPendingAutoConvert(true)
      }
    } else if (sourceFile && requiresDependencyFolder(sourceFile.name)) {
      setConverterStatus(`"${sourceFile.name}" still needs a dependency folder.`)
    }
  }, [appendLog, depsPromptSource, sourceFile])

  const runConvert = useCallback(async (options?: { autoLoad?: boolean }) => {
    if (!sourceFile) {
      setConverterStatus('Choose a source effect first.')
      return
    }
    if (converting) return

    if (requiresDependencyFolder(sourceFile.name) && depsFiles.length === 0) {
      const message = 'This .efkefc references external resources. Choose dependency folder first (Texture/Model/Material/Sound).'
      setError(message)
      setConverterStatus(message)
      appendLog(message)
      requestDepsFolder(sourceFile.name)
      return
    }

    setConverting(true)
    setLoadingMessage(`Converting package: ${sourceFile.name}`)
    setError('')
    setConverterStatus(`Converting ${sourceFile.name}...`)
    appendLog(`Converting ${sourceFile.name}`)

    try {
      const sourceBuffer = await sourceFile.arrayBuffer()
      const extraFiles: ConverterInputFile[] = await Promise.all(
        depsFiles.map(async (file) => ({
          name: file.name,
          relativePath: file.webkitRelativePath || file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        }))
      )

      const sourceExt = sourceFile.name.toLowerCase()
      const canUseNative =
        useNativeConverter &&
        (sourceExt.endsWith('.efkefc') || sourceExt.endsWith('.efkpkg'))

      let result: ConvertedPackage
      let backendTag = 'js'
      if (canUseNative) {
        try {
          appendLog('Running native converter API.')
          result = await convertToEfwgpkNative(sourceFile.name, sourceBuffer, extraFiles, {
            injectMesh: injectMeshNative,
          })
          if (injectMeshNative && result.meshInjected !== true) {
            throw new Error('Native conversion completed without watermark injection.')
          }
          backendTag = injectMeshNative
            ? (result.meshInjected === false ? 'native-no-mesh' : 'native-mesh')
            : 'native'
          if (injectMeshNative) {
            appendLog('Preview watermark injection confirmed.')
          }
        } catch (nativeCause) {
          const nativeMessage = nativeCause instanceof Error ? nativeCause.message : String(nativeCause)
          if (injectMeshNative) {
            throw new Error(`Native mesh injection failed: ${nativeMessage}`)
          }
          appendLog(`Native converter failed, fallback to JS: ${nativeMessage}`)
          result = await convertToEfwgpk(sourceFile.name, sourceBuffer, extraFiles)
          backendTag = 'js-fallback'
        }
      } else {
        result = await convertToEfwgpk(sourceFile.name, sourceBuffer, extraFiles)
      }

      setConvertedPackage(result)
      setConvertedList((prev) => {
        const exists = prev.some((item) => item.outputName === result.outputName)
        if (exists) return prev.map((item) => item.outputName === result.outputName ? result : item)
        return [...prev, result]
      })
      setConverterStatus(
        `[${backendTag}] ${result.outputName}  ${result.entries} entries  ${(result.bytes.byteLength / 1024).toFixed(1)} KB  deps:${extraFiles.length}/${result.depsPacked}`
      )
      appendLog(
        `Built ${result.outputName} entries=${result.entries} sizeKB=${(result.bytes.byteLength / 1024).toFixed(1)} deps=${extraFiles.length}/${result.depsPacked}`
      )
      if (result.backendRevision) {
        appendLog(`Native backend revision: ${result.backendRevision}`)
      }
      const summary = summarizeEfwgpk(result.bytes)
      if (summary) {
        appendLog(
          `Package assets: png=${summary.png} model=${summary.models} mat=${summary.materials} sound=${summary.sounds}`
        )
      }
      if (options?.autoLoad !== false) {
        try {
          setLoadingMessage(`Loading effect preview: ${result.outputName}`)
          await loadConvertedPreview(result)
        } catch (previewCause) {
          const previewMessage = previewCause instanceof Error ? previewCause.message : String(previewCause)
          setError(previewMessage)
          appendLog(previewMessage)
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setConvertedPackage(null)
      setError(message)
      setConverterStatus(message)
      appendLog(message)
    } finally {
      setLoadingMessage('')
      setConverting(false)
    }
  }, [appendLog, converting, depsFiles, injectMeshNative, loadConvertedPreview, requestDepsFolder, sourceFile, useNativeConverter])

  useEffect(() => {
    if (!pendingAutoConvert) return
    if (!sourceFile) {
      setPendingAutoConvert(false)
      return
    }
    if (converting) return
    if (requiresDependencyFolder(sourceFile.name) && depsFiles.length === 0) return
    setPendingAutoConvert(false)
    void runConvert({ autoLoad: true })
  }, [converting, depsFiles, pendingAutoConvert, runConvert, sourceFile])

  const downloadConverted = useCallback(() => {
    if (!convertedPackage) return
    const url = URL.createObjectURL(
      new Blob([toArrayBuffer(convertedPackage.bytes)], { type: 'application/octet-stream' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = convertedPackage.outputName
    link.click()
    URL.revokeObjectURL(url)
    appendLog(`Downloaded ${convertedPackage.outputName}`)
  }, [appendLog, convertedPackage])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlayback()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [togglePlayback])

  const lockedConvertedList = convertedList.filter((item) => !unlockedDownloads.has(item.outputName))
  const libraryList = convertedList.filter((item) => unlockedDownloads.has(item.outputName))

  return (
    <div className="app-root">
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="brand-dot" />
          <span className="brand-text">EFFEKSEER</span>
          <span className="brand-sep">·</span>
          <span className="header-meta">WebGPU Converter</span>
        </div>
        <span className="header-spacer" />
        {error ? <span className="header-error">{error}</span> : null}

        <div className="header-profile">
          <div className="credit-pill" title="Current Balance">
            <span className="coin-icon" style={{ display: 'inline-flex' }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" color="#daa520">
                <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="rgba(218,165,32,0.2)"/>
                <path d="M8 4V12M6 6H10M6 10H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </span>
            {credits} <span className="credit-label">Credits</span>
          </div>
          <div className="profile-dropdown-container">
            <button className="profile-btn" onClick={() => setShowProfileMenu(!showProfileMenu)}>
              <div className="avatar">
                <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=Max&backgroundColor=c0aede" alt="Profile" />
              </div>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
            </button>
            {showProfileMenu && (
              <div className="profile-menu">
                <div className="menu-item" onClick={() => setShowProfileMenu(false)}>Buy Credits</div>
                <div className="menu-item" onClick={() => setShowProfileMenu(false)}>Settings</div>
                <div className="menu-sep"></div>
                <div className="menu-item" onClick={() => setShowProfileMenu(false)}>Sign Out</div>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="menu-bar">
        <div className="menu-item">
          File
          <div className="menu-dropdown">
            <button type="button" className="menu-action" onClick={() => sourceInputRef.current?.click()}>
              <span>Import</span>
            </button>
            <div className="menu-sep" />
            <button type="button" className="menu-action" onClick={downloadConverted} disabled={!convertedPackage}>
              <span>Export</span>
            </button>
          </div>
        </div>
        <div className="menu-item">
          View
          <div className="menu-dropdown">
            <button type="button" className="menu-action" onClick={() => {
              const controls = controlsRef.current
              if (controls) {
                controls.target.set(0, 1, 0)
                controls.object.position.set(9, 4.5, 9)
                controls.update()
              }
              setShowSceneCube(false)
              setShowGrid(true)
              setBgColor('#111113')
              setGridColor('#ffffff')
            }}>
              <span>{'\u2002\u2002'}Reset View</span>
            </button>
            <div className="menu-sep" />
            <button type="button" className="menu-action" onClick={() => setShowSceneCube((v) => !v)}>
              <span>{showSceneCube ? '✓ Cube' : '\u2002\u2002Cube'}</span>
            </button>
            <div className="menu-action" onClick={(e) => {
              if ((e.target as HTMLElement).tagName !== 'INPUT') {
                setShowGrid((v) => !v)
              }
            }}>
              <span>{showGrid ? '✓ Grid' : '\u2002\u2002Grid'}</span>
              <input type="color" value={gridColor} onChange={(e) => setGridColor(e.target.value)} className="menu-color-input" title="Grid Color" />
            </div>
            <label className="menu-action menu-color">
              <span>{'\u2002\u2002'}Background</span>
              <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="menu-color-input" />
            </label>
            <div className="menu-sep" />
            <button type="button" className="menu-action" onClick={() => setShowStats((v) => !v)}>
              <span>{showStats ? '✓ Stats' : '\u2002\u2002Stats'}</span>
            </button>
            <div className="menu-sep" />
            <button type="button" className="menu-action" onClick={() => setSidebarCollapsed((v) => !v)}>
              <span>{'\u2002\u2002'}{sidebarCollapsed ? 'Show Sidebar' : 'Hide Sidebar'}</span>
            </button>
          </div>
        </div>
        <div className="menu-item">
          Library
          <div className="menu-dropdown">
            {libraryList.length === 0 ? (
              <div className="menu-action" style={{ color: '#666', cursor: 'default' }}>
                <span>No unlocked effects yet</span>
              </div>
            ) : (
              libraryList.map((item) => {
                const active = activeEffectId === 'converted-preview' && convertedPackage?.outputName === item.outputName
                return (
                  <button 
                    key={item.outputName} 
                    type="button" 
                    className="menu-action" 
                    onClick={() => {
                      setConvertedPackage(item)
                      void loadConvertedPreview(item)
                    }}
                    style={{ color: active ? '#daa520' : undefined }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#daa520' }}>
                        <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                        <path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>
                      </svg>
                      {(item.downloadOutputName || item.outputName).includes('.') ? (item.downloadOutputName || item.outputName).substring(0, (item.downloadOutputName || item.outputName).indexOf('.')) : (item.downloadOutputName || item.outputName)}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
        <div className="menu-item">
          Help
          <div className="menu-dropdown">
            <button type="button" className="menu-action" disabled>
              <span>Documentation</span>
            </button>
            <button type="button" className="menu-action" disabled>
              <span>About</span>
            </button>
          </div>
        </div>
      </nav>

      <input
        ref={sourceInputRef}
        className="hidden-input"
        type="file"
        accept=".efkefc,.efkpkg,.efkwgpk"
        onChange={handleSourceChange}
      />
      <input
        ref={depsInputRef}
        className="hidden-input"
        type="file"
        multiple
        onChange={handleDepsChange}
      />

      <div className="app-content">
        <div className="viewport">
          <canvas ref={canvasRef} className="render-canvas" />

          {(converting || (!!loadingMessage && !showDepsPrompt)) ? (
            <div className="viewport-loading">
              <div className="convert-progress-title">
                {loadingMessage || `Processing: ${sourceFile?.name || 'effect'}`}
              </div>
              <div className="convert-progress-bar" aria-hidden="true">
                <span />
              </div>
            </div>
          ) : null}

          <div className="viewport-controls">
            <button
              type="button"
              className={`ctrl-btn ${playback === 'playing' ? 'active' : ''}`}
              onClick={togglePlayback}
              disabled={!runtimeReady}
              title={playback === 'playing' ? 'Pause current effect' : 'Play current effect'}
            >
              {playback === 'playing' ? <IconPauseFilled /> : <IconPlayFilled />}
            </button>
            <button
              type="button"
              className="ctrl-btn"
              onClick={replayEffect}
              disabled={!runtimeReady}
              title="Replay active effect"
            >
              <IconReplayFilled />
            </button>
            <button
              type="button"
              className="ctrl-btn"
              onClick={stopEffect}
              disabled={!runtimeReady}
              title="Stop playback"
            >
              <IconStopFilled />
            </button>
            <button
              type="button"
              className="ctrl-btn"
              onClick={playNext}
              disabled={!runtimeReady}
              title={activeEffectId === 'converted-preview' ? "Next converted effect" : "Next sample effect"}
            >
              <IconNextFilled />
            </button>
            <div className="ctrl-sep" />
            <button
              type="button"
              className="ctrl-btn"
              onClick={() => setSidebarCollapsed((value) => !value)}
              title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              {sidebarCollapsed ? <IconChevronRightFilled /> : <IconChevronLeftFilled />}
            </button>
          </div>

          <div className="viewport-scene-tools">
            <div className="viewport-tools-header">Trigger</div>
            <div className="viewport-trigger-row">
              {TRIGGER_INDICES.map((index) => (
                <button
                  key={index}
                  type="button"
                  className="viewport-trigger-btn"
                  onClick={() => triggerEffect(index)}
                  disabled={!runtimeReady || playback === 'stopped'}
                >
                  {index}
                </button>
              ))}
            </div>
          </div>
        </div>

        <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          {/* ── Now Playing status bar ── */}
          {activeEffectId && (
            <div className="now-playing">
              <span className="now-playing-dot" />
              <span className="now-playing-label">
                {activeEffectId === 'converted-preview' && convertedPackage ? (
                  <>
                    {(convertedPackage.downloadOutputName || convertedPackage.outputName).includes('.') ? (convertedPackage.downloadOutputName || convertedPackage.outputName).substring(0, (convertedPackage.downloadOutputName || convertedPackage.outputName).indexOf('.')) : (convertedPackage.downloadOutputName || convertedPackage.outputName)}
                    <span className="ext-label">{(convertedPackage.downloadOutputName || convertedPackage.outputName).includes('.') ? (convertedPackage.downloadOutputName || convertedPackage.outputName).substring((convertedPackage.downloadOutputName || convertedPackage.outputName).indexOf('.')) : ''}</span>
                  </>
                ) : (
                  SAMPLE_EFFECTS.find((s) => s.id === activeEffectId)?.label || activeEffectId
                )}
              </span>
              <span className="now-playing-state">{playback}</span>
            </div>
          )}

          {libraryList.length > 0 && (
            <section className="converted-panel library-panel">
              <div className="panel-header collapsable-header" onClick={() => setShowLibraryList((v) => !v)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <svg style={{ transform: showLibraryList ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }} width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M5.5 3L10.5 8L5.5 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                  </svg>
                  Library
                </div>
              </div>
              {showLibraryList && (
                <div className="converted-list">
                  {libraryList.map((item) => {
                    const active = activeEffectId === 'converted-preview' && convertedPackage?.outputName === item.outputName
                    return (
                      <div 
                        key={item.outputName} 
                        className={`converted-item ${active ? 'active' : ''}`}
                        onClick={() => {
                          setConvertedPackage(item)
                          void loadConvertedPreview(item)
                        }}
                      >
                        <span className="converted-name" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#daa520" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                            <path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>
                          </svg>
                          {(item.downloadOutputName || item.outputName).includes('.') ? (item.downloadOutputName || item.outputName).substring(0, (item.downloadOutputName || item.outputName).indexOf('.')) : (item.downloadOutputName || item.outputName)}
                          <span className="ext-label">{(item.downloadOutputName || item.outputName).includes('.') ? (item.downloadOutputName || item.outputName).substring((item.downloadOutputName || item.outputName).indexOf('.')) : ''}</span>
                        </span>
                        <button
                          type="button"
                          className="converted-action unlocked"
                          title={`Download ${item.downloadOutputName || item.outputName}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            const targetBytes = item.downloadBytes || item.bytes
                            const url = URL.createObjectURL(
                              new Blob([toArrayBuffer(targetBytes)], { type: 'application/octet-stream' })
                            )
                            const link = document.createElement('a')
                            link.href = url
                            link.download = item.downloadOutputName || item.outputName
                            link.click()
                            URL.revokeObjectURL(url)
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M8 1v9m0 0L5 7m3 3l3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="converted-action converted-remove"
                          title={`Remove ${item.outputName}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            setConvertedList((prev) => prev.filter((p) => p.outputName !== item.outputName))
                            if (convertedPackage?.outputName === item.outputName) {
                              setConvertedPackage(null)
                              clearConvertedRegistration()
                              setPlayback('stopped')
                            }
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
                          </svg>
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          {lockedConvertedList.length > 0 && (
            <section className="converted-panel">
              <div className="panel-header collapsable-header" onClick={() => setShowConvertedList((v) => !v)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <svg style={{ transform: showConvertedList ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }} width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M5.5 3L10.5 8L5.5 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                  </svg>
                  Converted
                </div>
                {lockedConvertedList.length > 1 && (
                  <button type="button" className="panel-header-action" title="Download All" onClick={(e) => e.stopPropagation()}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 1v9m0 0L5 7m3 3l3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  </button>
                )}
              </div>
              {showConvertedList && (
                <div className="converted-list">
                {lockedConvertedList.map((item) => {
                  const active = activeEffectId === 'converted-preview' && convertedPackage?.outputName === item.outputName
                  return (
                  <div 
                    key={item.outputName} 
                    className={`converted-item ${active ? 'active' : ''}`}
                    onClick={() => {
                      setConvertedPackage(item)
                      void loadConvertedPreview(item)
                    }}
                  >
                    <span className="converted-name" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {unlockedDownloads.has(item.outputName) && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#daa520" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                          <path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>
                        </svg>
                      )}
                      {(item.downloadOutputName || item.outputName).includes('.') ? (item.downloadOutputName || item.outputName).substring(0, (item.downloadOutputName || item.outputName).indexOf('.')) : (item.downloadOutputName || item.outputName)}
                      <span className="ext-label">{(item.downloadOutputName || item.outputName).includes('.') ? (item.downloadOutputName || item.outputName).substring((item.downloadOutputName || item.outputName).indexOf('.')) : ''}</span>
                    </span>
                    <button
                      type="button"
                      className={`converted-action ${unlockedDownloads.has(item.outputName) ? 'unlocked' : 'locked'}`}
                      title={unlockedDownloads.has(item.outputName) ? `Download ${item.downloadOutputName || item.outputName}` : `Unlock ${item.downloadOutputName || item.outputName} (1 Credit)`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (unlockedDownloads.has(item.outputName)) {
                          const targetBytes = item.downloadBytes || item.bytes
                          const url = URL.createObjectURL(
                            new Blob([toArrayBuffer(targetBytes)], { type: 'application/octet-stream' })
                          )
                          const link = document.createElement('a')
                          link.href = url
                          link.download = item.downloadOutputName || item.outputName
                          link.click()
                          URL.revokeObjectURL(url)
                        } else {
                          setShowUnlockModal(item)
                        }
                      }}
                    >
                      {unlockedDownloads.has(item.outputName) ? (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 1v9m0 0L5 7m3 3l3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                        </svg>
                      ) : (
                        <div style={{display: 'flex', alignItems: 'center', gap: '3px', fontWeight: 600, fontSize: '11px'}}>
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                            <path fillRule="evenodd" d="M8 2a3.5 3.5 0 00-3.5 3.5V7h-1v7h9V7h-1V5.5A3.5 3.5 0 008 2zm2.5 5V5.5a2.5 2.5 0 00-5 0V7h5zM9 10a1 1 0 11-2 0 1 1 0 012 0z" clipRule="evenodd"/>
                          </svg>
                          1
                        </div>
                      )}
                    </button>
                    <button
                      type="button"
                      className="converted-action converted-remove"
                      title={`Remove ${item.outputName}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setConvertedList((prev) => prev.filter((p) => p.outputName !== item.outputName))
                        if (convertedPackage?.outputName === item.outputName) {
                           setConvertedPackage(null)
                           clearConvertedRegistration()
                           setPlayback('stopped')
                        }
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
                      </svg>
                    </button>
                  </div>
                )})}
              </div>
              )}
            </section>
          )}

          <section className="samples-panel">
            <div className="panel-header collapsable-header" onClick={() => setShowSamplesList((v) => !v)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <svg style={{ transform: showSamplesList ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }} width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M5.5 3L10.5 8L5.5 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                </svg>
                Samples
              </div>
            </div>
            {showSamplesList && (
              <div className="samples-list">
              <div className="samples-group">
                {SAMPLE_EFFECTS.map((effect) => {
                  const active = activeEffectId === effect.id
                  return (
                    <button
                      key={effect.id}
                      type="button"
                      className={`sample-tile ${active ? 'active' : ''}`}
                      onClick={() => selectSample(effect.id)}
                      disabled={!runtimeReady}
                    >
                      <span className={`sample-dot ${active ? 'active' : ''}`} />
                      <span className="sample-name">
                        {effect.label.includes('.') ? effect.label.substring(0, effect.label.indexOf('.')) : effect.label}
                        <span className="ext-label">{effect.label.includes('.') ? effect.label.substring(effect.label.indexOf('.')) : ''}</span>
                      </span>
                      <span className="sample-note">{effect.note}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            )}
          </section>
        </aside>
      </div>

      {showDepsPrompt ? (
        <div
          className="deps-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Select dependency folder"
          onClick={openDepsPicker}
        >
          <div className="deps-modal">
            <div className="deps-modal-title">
              Dependency Folder Required: {depsPromptSource || sourceFile?.name || 'effect'}
            </div>
            <div className="convert-progress-bar" aria-hidden="true">
              <span />
            </div>
          </div>
        </div>
      ) : null}

      {/* Unlock Confirmation Modal */}
      {showUnlockModal && (
        <div className="modal-overlay" onClick={() => setShowUnlockModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Unlock Premium Download?</h2>
              <button className="modal-close" onClick={() => setShowUnlockModal(null)}>×</button>
            </div>
            <div className="modal-body">
              <p>You are about to unlock the pure, web-ready version of <strong>{showUnlockModal.downloadOutputName || showUnlockModal.outputName}</strong>.</p>
              
              <div className="modal-cost-box">
                <span className="cost-label">Cost:</span>
                <span className="cost-value" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="rgba(218,165,32,0.2)"/>
                    <path d="M8 4V12M6 6H10M6 10H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  -1
                </span>
              </div>
              
              <div className="modal-balance">
                You have <strong>{credits}</strong> credits remaining.
              </div>

              {credits < 1 && (
                <div className="modal-error">Not enough credits! Please purchase more to unlock.</div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowUnlockModal(null)}>Cancel</button>
              <button 
                className="btn-primary" 
                disabled={credits < 1}
                onClick={() => {
                  if (credits >= 1) {
                    setCredits(c => c - 1)
                    setUnlockedDownloads(prev => new Set([...prev, showUnlockModal.outputName]))
                    
                    // Auto-download after unlocking
                    const targetBytes = showUnlockModal.downloadBytes || showUnlockModal.bytes
                    const url = URL.createObjectURL(
                      new Blob([toArrayBuffer(targetBytes)], { type: 'application/octet-stream' })
                    )
                    const link = document.createElement('a')
                    link.href = url
                    link.download = showUnlockModal.downloadOutputName || showUnlockModal.outputName
                    link.click()
                    URL.revokeObjectURL(url)
                    
                    setShowUnlockModal(null)
                  }
                }}
              >
                Unlock & Download
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
