import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { Check, LibraryBig, Sparkles } from 'lucide-react'
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
  getUpdateTime?: () => number
  getDrawTime?: () => number
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

type RuntimeConfig = {
  mode: 'basic' | 'composite'
  hdrOutput: boolean
  antialias: boolean
  instanceMaxCount: number
  squareMaxCount: number
}

type PersistedUiSettings = {
  sidebarCollapsed: boolean
  showSceneCube: boolean
  showGrid: boolean
  showFloor: boolean
  showStats: boolean
  bgColor: string
  gridColor: string
  floorColor: string
  showSamplesList: boolean
  runtimeConfig: RuntimeConfig
}


type IconProps = {
  size?: number
}

type MenuCheckLabelProps = {
  label: string
  checked?: boolean
  description?: string
}

const MenuCheckLabel = ({ label, checked = false, description }: MenuCheckLabelProps) => (
  <span className="menu-check-block">
    <span className="menu-check-label">
      <span className={`menu-check-slot ${checked ? 'checked' : ''}`} aria-hidden="true">
        {checked ? <Check size={13} strokeWidth={2.4} /> : null}
      </span>
      <span>{label}</span>
    </span>
    {description ? <span className="menu-check-description">{description}</span> : null}
  </span>
)

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

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  mode: 'basic',
  hdrOutput: false,
  antialias: false,
  instanceMaxCount: 4000,
  squareMaxCount: 10000,
}

const DEFAULT_FLOOR_COLOR = '#505768'
const UI_SETTINGS_STORAGE_KEY = 'effekseer-webgpu-converter-ui-v1'

let sharedWebGPUDevicePromise: Promise<GPUDevice> | null = null
let effekseerRuntimeInitialized = false

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

const isEfkefcSource = (fileName: string): boolean => {
  const lower = fileName.toLowerCase()
  return lower.endsWith('.efkefc')
}

const looksLikeMissingDependencyError = (message: string): boolean => {
  if (!message) return false

  const lower = message.toLowerCase()
  const missingHints = [
    'missing',
    'not found',
    'failed to load',
    'cannot find',
    'could not find',
    'unresolved',
  ]
  const dependencyHints = [
    'dependency',
    'dependencies',
    'resource',
    'resources',
    'texture',
    'model',
    'material',
    'sound',
    '.png',
    '.jpg',
    '.jpeg',
    '.dds',
    '.tga',
    '.bmp',
    '.efkmodel',
    '.mqo',
    '.wav',
    '.ogg',
    '.mp3',
  ]

  return missingHints.some((hint) => lower.includes(hint)) &&
    dependencyHints.some((hint) => lower.includes(hint))
}

const requestSharedWebGPUDevice = async (): Promise<GPUDevice> => {
  if (sharedWebGPUDevicePromise) {
    return sharedWebGPUDevicePromise
  }

  sharedWebGPUDevicePromise = (async () => {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) {
      throw new Error('Unable to create WebGPU adapter.')
    }

    const features = Array.from(adapter.features.values()) as GPUFeatureName[]
    return adapter.requestDevice({ requiredFeatures: features })
  })()

  return sharedWebGPUDevicePromise
}

const clampPositiveInt = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.round(value))
}

const areRuntimeConfigsEqual = (a: RuntimeConfig, b: RuntimeConfig): boolean => (
  a.mode === b.mode &&
  a.hdrOutput === b.hdrOutput &&
  a.antialias === b.antialias &&
  a.instanceMaxCount === b.instanceMaxCount &&
  a.squareMaxCount === b.squareMaxCount
)

const normalizeRuntimeConfig = (config: RuntimeConfig): RuntimeConfig => ({
  mode: config.mode,
  hdrOutput: config.hdrOutput,
  antialias: config.antialias,
  instanceMaxCount: clampPositiveInt(config.instanceMaxCount, DEFAULT_RUNTIME_CONFIG.instanceMaxCount),
  squareMaxCount: clampPositiveInt(config.squareMaxCount, DEFAULT_RUNTIME_CONFIG.squareMaxCount),
})

const describeRuntimeConfigChanges = (current: RuntimeConfig, next: RuntimeConfig): string[] => {
  const changes: string[] = []
  if (current.mode !== next.mode) {
    changes.push(`Pass Mode: ${next.mode === 'basic' ? 'Basic' : 'Composite'}`)
  }
  if (current.hdrOutput !== next.hdrOutput) {
    changes.push(`Output: ${next.hdrOutput ? 'HDR' : 'LDR'}`)
  }
  if (current.antialias !== next.antialias) {
    changes.push(`Antialias: ${next.antialias ? 'On' : 'Off'}`)
  }
  if (current.instanceMaxCount !== next.instanceMaxCount) {
    changes.push(`Instance Max: ${next.instanceMaxCount}`)
  }
  if (current.squareMaxCount !== next.squareMaxCount) {
    changes.push(`Square Max: ${next.squareMaxCount}`)
  }
  return changes
}

const sanitizeColor = (value: unknown, fallback: string): string => {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

const readPersistedUiSettings = (): PersistedUiSettings => {
  const defaults: PersistedUiSettings = {
    sidebarCollapsed: false,
    showSceneCube: true,
    showGrid: true,
    showFloor: false,
    showStats: false,
    bgColor: '#000000',
    gridColor: '#ffffff',
    floorColor: DEFAULT_FLOOR_COLOR,
    showSamplesList: true,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
  }

  if (typeof window === 'undefined') {
    return defaults
  }

  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY)
    if (!raw) return defaults

    const parsed = JSON.parse(raw) as Partial<PersistedUiSettings> | null
    if (!parsed || typeof parsed !== 'object') return defaults

    const runtimeCandidate: Partial<RuntimeConfig> = parsed.runtimeConfig && typeof parsed.runtimeConfig === 'object'
      ? parsed.runtimeConfig as Partial<RuntimeConfig>
      : {}

    return {
      sidebarCollapsed: typeof parsed.sidebarCollapsed === 'boolean' ? parsed.sidebarCollapsed : defaults.sidebarCollapsed,
      showSceneCube: typeof parsed.showSceneCube === 'boolean' ? parsed.showSceneCube : defaults.showSceneCube,
      showGrid: typeof parsed.showGrid === 'boolean' ? parsed.showGrid : defaults.showGrid,
      showFloor: typeof parsed.showFloor === 'boolean' ? parsed.showFloor : defaults.showFloor,
      showStats: typeof parsed.showStats === 'boolean' ? parsed.showStats : defaults.showStats,
      bgColor: sanitizeColor(parsed.bgColor, defaults.bgColor),
      gridColor: sanitizeColor(parsed.gridColor, defaults.gridColor),
      floorColor: sanitizeColor(parsed.floorColor, defaults.floorColor),
      showSamplesList: typeof parsed.showSamplesList === 'boolean' ? parsed.showSamplesList : defaults.showSamplesList,
      runtimeConfig: normalizeRuntimeConfig({
        mode: runtimeCandidate.mode === 'basic' || runtimeCandidate.mode === 'composite'
          ? runtimeCandidate.mode
          : defaults.runtimeConfig.mode,
        hdrOutput: typeof runtimeCandidate.hdrOutput === 'boolean' ? runtimeCandidate.hdrOutput : defaults.runtimeConfig.hdrOutput,
        antialias: typeof runtimeCandidate.antialias === 'boolean' ? runtimeCandidate.antialias : defaults.runtimeConfig.antialias,
        instanceMaxCount: typeof runtimeCandidate.instanceMaxCount === 'number' ? runtimeCandidate.instanceMaxCount : defaults.runtimeConfig.instanceMaxCount,
        squareMaxCount: typeof runtimeCandidate.squareMaxCount === 'number' ? runtimeCandidate.squareMaxCount : defaults.runtimeConfig.squareMaxCount,
      }),
    }
  } catch {
    return defaults
  }
}

const writePersistedUiSettings = (settings: PersistedUiSettings) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Ignore storage failures.
  }
}

export default function EffekseerConverterCanvas() {
  const persistedUiSettingsRef = useRef<PersistedUiSettings | null>(null)
  if (persistedUiSettingsRef.current === null) {
    persistedUiSettingsRef.current = readPersistedUiSettings()
  }
  const persistedUiSettings = persistedUiSettingsRef.current

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cubeRef = useRef<THREE.Mesh | null>(null)
  const gridRef = useRef<THREE.GridHelper | null>(null)
  const floorRef = useRef<THREE.Mesh | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const sourceInputRef = useRef<HTMLInputElement | null>(null)
  const depsInputRef = useRef<HTMLInputElement | null>(null)
  const menuBarRef = useRef<HTMLElement | null>(null)
  const profileMenuRef = useRef<HTMLDivElement | null>(null)
  const runtimeRef = useRef<RuntimeState>(createRuntimeState())

  const [runtimeReady, setRuntimeReady] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(persistedUiSettings.sidebarCollapsed)
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
  const [showSceneCube, setShowSceneCube] = useState(persistedUiSettings.showSceneCube)
  const [showGrid, setShowGrid] = useState(persistedUiSettings.showGrid)
  const [showFloor, setShowFloor] = useState(persistedUiSettings.showFloor)
  const [showStats, setShowStats] = useState(persistedUiSettings.showStats)
  const [cpuStatus, setCpuStatus] = useState('')
  const [bgColor, setBgColor] = useState(persistedUiSettings.bgColor)
  const [gridColor, setGridColor] = useState(persistedUiSettings.gridColor)
  const [floorColor, setFloorColor] = useState(persistedUiSettings.floorColor)
  const [showSamplesList, setShowSamplesList] = useState(persistedUiSettings.showSamplesList)
  const [convertedList, setConvertedList] = useState<Array<ConvertedPackage>>([])
  const [convertedPackage, setConvertedPackage] = useState<ConvertedPackage | null>(null)
  const [, setConverterStatus] = useState('Choose or drop .efkefc, .efkpkg, or .efkwgpk')
  
  // Credits System
  const [credits, setCredits] = useState(5)
  const [unlockedDownloads, setUnlockedDownloads] = useState<Set<string>>(new Set())
  const [showUnlockModal, setShowUnlockModal] = useState<ConvertedPackage | null>(null)
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [runtimeConfigDraft, setRuntimeConfigDraft] = useState<RuntimeConfig>(persistedUiSettings.runtimeConfig)
  const [runtimeConfigApplied, setRuntimeConfigApplied] = useState<RuntimeConfig>(persistedUiSettings.runtimeConfig)
  const [showCanvasResetModal, setShowCanvasResetModal] = useState(false)
  const [pendingRuntimeConfig, setPendingRuntimeConfig] = useState<RuntimeConfig | null>(null)

  const useNativeConverter = true
  const injectMeshNative = true
  const showStatsRef = useRef(showStats)
  const runtimeConfigPromptTimerRef = useRef<number | null>(null)
  const cpuStatsRef = useRef({
    accumMs: 0,
    frames: 0,
    stamp: performance.now(),
    lastAvgMs: null as number | null,
    lastUiUpdate: 0,
    lastText: '',
  })

  useEffect(() => {
    showStatsRef.current = showStats
    if (!showStats) {
      setCpuStatus('')
    }
  }, [showStats])

  useEffect(() => {
    writePersistedUiSettings({
      sidebarCollapsed,
      showSceneCube,
      showGrid,
      showFloor,
      showStats,
      bgColor,
      gridColor,
      floorColor,
      showSamplesList,
      runtimeConfig: runtimeConfigApplied,
    })
  }, [
    bgColor,
    floorColor,
    gridColor,
    runtimeConfigApplied,
    showFloor,
    showGrid,
    showSamplesList,
    showSceneCube,
    showStats,
    sidebarCollapsed,
  ])

  const appendLog = useCallback((message: string) => {
    if (!message) return
    console.info(`[EffekseerConverter] ${message}`)
  }, [])

  const openHeaderMenu = useCallback((menu: string) => {
    setShowProfileMenu(false)
    setOpenMenu(menu)
  }, [])

  const toggleProfileMenu = useCallback(() => {
    setOpenMenu(null)
    setShowProfileMenu((current) => !current)
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
              (message: string, path: string) => reject(new Error(path ? `${message} (${path})` : message))
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
        (message: string, path: string) => reject(new Error(path ? `${message} (${path})` : message))
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
    const floor = floorRef.current
    if (floor) floor.visible = showFloor
  }, [showFloor])

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
    const floor = floorRef.current
    if (floor && floor.material instanceof THREE.MeshBasicMaterial) {
      floor.material.color.set(floorColor)
      floor.material.needsUpdate = true
    }
  }, [floorColor])

  const resetView = useCallback(() => {
    const controls = controlsRef.current
    if (controls) {
      controls.target.set(0, 1, 0)
      controls.object.position.set(9, 4.5, 9)
      controls.update()
    }
    setShowSceneCube(false)
    setShowGrid(true)
    setShowFloor(false)
    setBgColor('#000000')
    setGridColor('#ffffff')
    setFloorColor(DEFAULT_FLOOR_COLOR)
  }, [])

  const queueRuntimeConfigReload = useCallback((nextConfig: RuntimeConfig) => {
    const normalized = normalizeRuntimeConfig(nextConfig)
    setRuntimeConfigDraft(normalized)
    if (runtimeConfigPromptTimerRef.current !== null) {
      window.clearTimeout(runtimeConfigPromptTimerRef.current)
      runtimeConfigPromptTimerRef.current = null
    }
    if (areRuntimeConfigsEqual(normalized, runtimeConfigApplied)) {
      setPendingRuntimeConfig(null)
      setShowCanvasResetModal(false)
      return
    }
    setPendingRuntimeConfig(normalized)
    setShowCanvasResetModal(true)
  }, [runtimeConfigApplied])

  const scheduleRuntimeConfigReload = useCallback((nextConfig: RuntimeConfig) => {
    setRuntimeConfigDraft(nextConfig)
    if (runtimeConfigPromptTimerRef.current !== null) {
      window.clearTimeout(runtimeConfigPromptTimerRef.current)
    }
    runtimeConfigPromptTimerRef.current = window.setTimeout(() => {
      runtimeConfigPromptTimerRef.current = null
      queueRuntimeConfigReload(nextConfig)
    }, 600)
  }, [queueRuntimeConfigReload])

  const confirmCanvasReset = useCallback(() => {
    if (runtimeConfigPromptTimerRef.current !== null) {
      window.clearTimeout(runtimeConfigPromptTimerRef.current)
      runtimeConfigPromptTimerRef.current = null
    }
    if (!pendingRuntimeConfig) {
      setShowCanvasResetModal(false)
      return
    }
    setRuntimeConfigApplied(pendingRuntimeConfig)
    setRuntimeConfigDraft(pendingRuntimeConfig)
    setPendingRuntimeConfig(null)
    setShowCanvasResetModal(false)
  }, [pendingRuntimeConfig])

  const cancelCanvasReset = useCallback(() => {
    if (runtimeConfigPromptTimerRef.current !== null) {
      window.clearTimeout(runtimeConfigPromptTimerRef.current)
      runtimeConfigPromptTimerRef.current = null
    }
    setRuntimeConfigDraft(runtimeConfigApplied)
    setPendingRuntimeConfig(null)
    setShowCanvasResetModal(false)
  }, [runtimeConfigApplied])

  useEffect(() => () => {
    if (runtimeConfigPromptTimerRef.current !== null) {
      window.clearTimeout(runtimeConfigPromptTimerRef.current)
      runtimeConfigPromptTimerRef.current = null
    }
  }, [])

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
    const effekseerApi = effekseer

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

    const grid = new THREE.GridHelper(20, 10, gridColor, gridColor)
    if (!Array.isArray(grid.material)) {
      grid.material.vertexColors = false
      grid.material.color.set(gridColor)
      grid.material.needsUpdate = true
    }
    const floorGeometry = new THREE.PlaneGeometry(24, 24)
    const floorMaterial = new THREE.MeshBasicMaterial({
      color: floorColor,
      side: THREE.DoubleSide,
    })
    const floor = new THREE.Mesh(floorGeometry, floorMaterial)
    floor.rotation.x = -Math.PI * 0.5
    floor.position.y = -0.015
    floor.visible = showFloor
    const geometry = new THREE.BoxGeometry(2, 2, 2)
    const material = new THREE.MeshBasicMaterial({ color: '#cc4c4c' })
    const cube = new THREE.Mesh(geometry, material)
    cube.visible = showSceneCube
    cubeRef.current = cube
    gridRef.current = grid
    floorRef.current = floor
    controlsRef.current = controls
    scene.add(floor, grid, cube)

    let renderer: THREE.WebGPURenderer | null = null

    const resize = () => {
      const pass = runtimeRef.current.pass
      if (!pass || !renderer) return

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
      const handleAlive = isHandleAlive(handle)
      if (handle && !handleAlive) {
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

      if (showStatsRef.current) {
        const stats = cpuStatsRef.current

        if (!handleAlive) {
          stats.accumMs = 0
          stats.frames = 0
          stats.lastAvgMs = null
          stats.stamp = performance.now()
          if (stats.lastText !== 'CPU Usage: idle (no active effects)') {
            stats.lastText = 'CPU Usage: idle (no active effects)'
            setCpuStatus('CPU Usage: idle (no active effects)')
          }
          frame = window.requestAnimationFrame(render)
          return
        }

        const ctx = runtimeRef.current.ctx
        const updateUs = ctx?.getUpdateTime ? ctx.getUpdateTime() || 0 : 0
        const drawUs = ctx?.getDrawTime ? ctx.getDrawTime() || 0 : 0
        if (updateUs || drawUs) {
          const totalUs = updateUs + drawUs
          stats.accumMs += totalUs / 1000
          stats.frames += 1
          const now = performance.now()
          if (now - stats.stamp >= 1000) {
            stats.lastAvgMs = stats.accumMs / Math.max(1, stats.frames)
            stats.accumMs = 0
            stats.frames = 0
            stats.stamp = now
          }
          if (now - stats.lastUiUpdate >= 250) {
            const avgText = stats.lastAvgMs !== null ? ` | avg ${stats.lastAvgMs.toFixed(2)} ms/frame` : ''
            const nextText =
              `CPU Usage: ${Math.round(totalUs)} us (update ${Math.round(updateUs)} / draw ${Math.round(drawUs)})${avgText}`
            stats.lastText = nextText
            setCpuStatus(nextText)
            stats.lastUiUpdate = now
          }
        } else if (stats.lastText !== 'CPU Usage: N/A (stats not available)') {
          stats.lastText = 'CPU Usage: N/A (stats not available)'
          setCpuStatus('CPU Usage: N/A (stats not available)')
        }
      }
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

    const disposeFloor = () => {
      floorGeometry.dispose()
      floorMaterial.dispose()
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
      effekseerApi.releaseContext(runtime.ctx)
      runtime.pass?.dispose()
      geometry.dispose()
      material.dispose()
      disposeGrid()
      disposeFloor()
      controls.dispose()
      renderer?.dispose()
      timer.dispose()
      cubeRef.current = null
      floorRef.current = null

      runtimeRef.current = createRuntimeState()
      setRuntimeReady(false)
      setPlayback('stopped')
    }

    void (async () => {
      try {
        appendLog('Creating WebGPU renderer.')
        const device = await requestSharedWebGPUDevice()
        renderer = new THREE.WebGPURenderer({
          canvas,
          alpha: false,
          antialias: runtimeConfigApplied.antialias,
          outputBufferType: runtimeConfigApplied.hdrOutput ? THREE.HalfFloatType : THREE.UnsignedByteType,
          device,
        })
        runtimeRef.current = {
          ...runtimeRef.current,
          renderer,
        }
        await renderer.init()
        if (cancelled) {
          cleanup()
          return
        }

        appendLog('Initializing Effekseer runtime.')
        if (!effekseerRuntimeInitialized) {
          effekseerApi.setWebGPUDevice(device)
          await effekseerApi.initRuntime('/effekseer-runtime/Effekseer_WebGPU_Runtime.wasm')
          ;(effekseerApi as unknown as { setLogEnabled?: (flag: boolean) => void }).setLogEnabled?.(true)
          effekseerRuntimeInitialized = true
          appendLog('Effekseer runtime native log enabled.')
        }
        if (cancelled) {
          cleanup()
          return
        }

        const ctx = effekseerApi.createContext() as ExtendedEffekseerContext | null
        if (!ctx) {
          throw new Error('Effekseer createContext() returned null.')
        }

        const settings = {
          instanceMaxCount: runtimeConfigApplied.instanceMaxCount,
          squareMaxCount: runtimeConfigApplied.squareMaxCount,
          externalRenderPass: true,
        }

        const initialized = typeof ctx.initExternal === 'function'
          ? ctx.initExternal(settings)
          : ctx.init(canvas, settings)

        if (!initialized) {
          throw new Error('Effekseer context initialization failed.')
        }

        const pass = new EffekseerRenderPass(renderer, scene, camera, ctx, {
          mode: runtimeConfigApplied.mode,
          idleOptimization: true,
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
  }, [appendLog, clearConvertedRegistration, playRegisteredEffect, releaseBuiltInEffects, runtimeConfigApplied])

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
    setShowDepsPrompt(false)
    setDepsPromptSource('')
    setLoadingMessage('')
    setPendingAutoConvert(!!nextFile)
    if (sourceInputRef.current) {
      sourceInputRef.current.value = ''
    }
  }, [])

  const handleDepsChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    setDepsFiles(files)
    if (files.length > 0) {
      setShowDepsPrompt(false)
      setLoadingMessage('')
      setError('')
      setConverterStatus(`Resources selected: ${files.length} files`)
      appendLog(`Resources selected for ${sourceFile?.name ?? depsPromptSource}: ${files.length} files.`)
      if (sourceFile && isEfkefcSource(sourceFile.name)) {
        setPendingAutoConvert(true)
      }
    } else if (sourceFile) {
      setConverterStatus(`Source: ${sourceFile.name}`)
    }
  }, [appendLog, depsPromptSource, sourceFile])

  const runConvert = useCallback(async (options?: { autoLoad?: boolean }) => {
    if (!sourceFile) {
      setConverterStatus('Choose a source effect first.')
      return
    }
    if (converting) return

    setConverting(true)
    setLoadingMessage(`Loading package: ${sourceFile.name}`)
    setError('')
    setConverterStatus(`Loading ${sourceFile.name}...`)
    appendLog(`Loading ${sourceFile.name}`)

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
      let shouldPersistResult = true
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
          if (depsFiles.length === 0 && isEfkefcSource(sourceFile.name) && looksLikeMissingDependencyError(previewMessage)) {
            shouldPersistResult = false
            appendLog(`Preview requires dependency folder: ${previewMessage}`)
            requestDepsFolder(sourceFile.name)
          } else {
            setError(previewMessage)
            appendLog(previewMessage)
          }
        }
      }
      if (shouldPersistResult) {
        setConvertedPackage(result)
        setConvertedList((prev) => {
          const exists = prev.some((item) => item.outputName === result.outputName)
          if (exists) return prev.map((item) => item.outputName === result.outputName ? result : item)
          return [...prev, result]
        })
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      appendLog(message)
      if (depsFiles.length === 0 && isEfkefcSource(sourceFile.name) && looksLikeMissingDependencyError(message)) {
        setConvertedPackage(null)
        requestDepsFolder(sourceFile.name)
      } else {
        setConvertedPackage(null)
        setError(message)
        setConverterStatus(message)
      }
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

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const menuBar = menuBarRef.current
      const profileMenu = profileMenuRef.current
      if (event.target instanceof Node) {
        if (menuBar?.contains(event.target)) return
        if (profileMenu?.contains(event.target)) return
      }
      setOpenMenu(null)
      setShowProfileMenu(false)
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null)
        setShowProfileMenu(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [])

  const libraryEntries = convertedList
  const unlockedLibraryEntries = libraryEntries.filter((item) => unlockedDownloads.has(item.outputName))
  const loadedLibraryEntries = libraryEntries.filter((item) => !unlockedDownloads.has(item.outputName))
  const pendingRuntimeChanges = pendingRuntimeConfig
    ? describeRuntimeConfigChanges(runtimeConfigApplied, pendingRuntimeConfig)
    : []
  const renderLibraryItem = (item: ConvertedPackage, unlocked: boolean) => {
    const active = activeEffectId === 'converted-preview' && convertedPackage?.outputName === item.outputName
    return (
      <div
        key={item.outputName}
        className={`converted-item ${active ? 'active' : ''} ${unlocked ? 'library-item-unlocked' : ''}`}
        onClick={() => {
          setConvertedPackage(item)
          void loadConvertedPreview(item)
        }}
      >
        <span className={`converted-name ${unlocked ? 'library-item-name-unlocked' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {unlocked ? (
            <span className="library-item-effect-icon" aria-hidden="true">
              <Sparkles size={12} strokeWidth={2} fill="currentColor" />
            </span>
          ) : null}
          {(item.downloadOutputName || item.outputName).includes('.') ? (item.downloadOutputName || item.outputName).substring(0, (item.downloadOutputName || item.outputName).indexOf('.')) : (item.downloadOutputName || item.outputName)}
          <span className="ext-label">{(item.downloadOutputName || item.outputName).includes('.') ? (item.downloadOutputName || item.outputName).substring((item.downloadOutputName || item.outputName).indexOf('.')) : ''}</span>
        </span>
        <button
          type="button"
          className={`converted-action ${unlocked ? 'unlocked' : 'locked'}`}
          title={unlocked ? `Download ${item.downloadOutputName || item.outputName}` : `Unlock ${item.downloadOutputName || item.outputName}`}
          onClick={(e) => {
            e.stopPropagation()
            if (unlocked) {
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
  }
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
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" color="#7aa2ff">
                <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="rgba(218,165,32,0.2)"/>
                <path d="M8 4V12M6 6H10M6 10H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </span>
            {credits} <span className="credit-label">Credits</span>
          </div>
          <div ref={profileMenuRef} className="profile-dropdown-container">
            <button className="profile-btn" onClick={toggleProfileMenu}>
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

      <nav ref={menuBarRef} className="menu-bar">
        <div
          className={`menu-item ${openMenu === 'file' ? 'open' : ''}`}
          onMouseEnter={() => openHeaderMenu('file')}
        >
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
        <div
          className={`menu-item ${openMenu === 'view' ? 'open' : ''}`}
          onMouseEnter={() => openHeaderMenu('view')}
        >
          View
          <div className="menu-dropdown">
            <button type="button" className="menu-action" onClick={resetView}>
              <MenuCheckLabel label="Reset View" />
            </button>
            <div className="menu-sep" />
            <button type="button" className="menu-action" onClick={() => setShowSceneCube((v) => !v)}>
              <MenuCheckLabel label="Cube" checked={showSceneCube} />
            </button>
            <div className="menu-action" onClick={(e) => {
              if ((e.target as HTMLElement).tagName !== 'INPUT') {
                setShowGrid((v) => !v)
              }
            }}>
              <MenuCheckLabel label="Grid" checked={showGrid} />
              <input type="color" value={gridColor} onChange={(e) => setGridColor(e.target.value)} className="menu-color-input" title="Grid Color" />
            </div>
            <div className="menu-action" onClick={(e) => {
              if ((e.target as HTMLElement).tagName !== 'INPUT') {
                setShowFloor((v) => !v)
              }
            }}>
              <MenuCheckLabel label="Floor" checked={showFloor} />
              <input type="color" value={floorColor} onChange={(e) => setFloorColor(e.target.value)} className="menu-color-input" title="Floor Color" />
            </div>
            <label className="menu-action menu-color">
              <MenuCheckLabel label="Background" />
              <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="menu-color-input" />
            </label>
            <div className="menu-sep" />
            <button type="button" className="menu-action" onClick={() => setShowStats((v) => !v)}>
              <MenuCheckLabel label="Stats" checked={showStats} />
            </button>
            <div className="menu-sep" />
            <button type="button" className="menu-action" onClick={() => setSidebarCollapsed((v) => !v)}>
              <MenuCheckLabel label={sidebarCollapsed ? 'Show Sidebar' : 'Hide Sidebar'} />
            </button>
          </div>
        </div>
        <div
          className={`menu-item ${openMenu === 'canvas' ? 'open' : ''}`}
          onMouseEnter={() => openHeaderMenu('canvas')}
        >
          Renderer
          <div className="menu-dropdown">
            <button type="button" className="menu-action" onClick={() => queueRuntimeConfigReload({ ...runtimeConfigDraft, mode: 'basic' })}>
              <MenuCheckLabel
                label="Basic Pass"
                checked={runtimeConfigDraft.mode === 'basic'}
                description="Lower overhead"
              />
            </button>
            <button type="button" className="menu-action" onClick={() => queueRuntimeConfigReload({ ...runtimeConfigDraft, mode: 'composite' })}>
              <MenuCheckLabel
                label="Composite Pass"
                checked={runtimeConfigDraft.mode === 'composite'}
                description="Supports soft particles and distortion"
              />
            </button>
            <div className="menu-sep" />
            <button type="button" className="menu-action" onClick={() => queueRuntimeConfigReload({ ...runtimeConfigDraft, hdrOutput: false })}>
              <MenuCheckLabel label="LDR" checked={!runtimeConfigDraft.hdrOutput} />
            </button>
            <button type="button" className="menu-action" onClick={() => queueRuntimeConfigReload({ ...runtimeConfigDraft, hdrOutput: true })}>
              <MenuCheckLabel label="HDR" checked={runtimeConfigDraft.hdrOutput} />
            </button>
            <button type="button" className="menu-action" onClick={() => queueRuntimeConfigReload({ ...runtimeConfigDraft, antialias: !runtimeConfigDraft.antialias })}>
              <MenuCheckLabel label="Antialias" checked={runtimeConfigDraft.antialias} />
            </button>
            <div className="menu-sep" />
            <label className="menu-action menu-field">
              <span>Instance Max</span>
              <input
                type="number"
                min={1}
                step={1}
                value={runtimeConfigDraft.instanceMaxCount}
                onChange={(event) => setRuntimeConfigDraft((current) => ({
                  ...current,
                  instanceMaxCount: Number(event.target.value),
                }))}
                onBlur={(event) => scheduleRuntimeConfigReload({
                  ...runtimeConfigDraft,
                  instanceMaxCount: Number(event.currentTarget.value),
                })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur()
                  } else if (event.key === 'Escape') {
                    cancelCanvasReset()
                    event.currentTarget.blur()
                  }
                }}
                className="menu-number-input"
              />
            </label>
            <label className="menu-action menu-field">
              <span>Square Max</span>
              <input
                type="number"
                min={1}
                step={1}
                value={runtimeConfigDraft.squareMaxCount}
                onChange={(event) => setRuntimeConfigDraft((current) => ({
                  ...current,
                  squareMaxCount: Number(event.target.value),
                }))}
                onBlur={(event) => scheduleRuntimeConfigReload({
                  ...runtimeConfigDraft,
                  squareMaxCount: Number(event.currentTarget.value),
                })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur()
                  } else if (event.key === 'Escape') {
                    cancelCanvasReset()
                    event.currentTarget.blur()
                  }
                }}
                className="menu-number-input"
              />
            </label>
          </div>
        </div>
        <div
          className={`menu-item ${openMenu === 'help' ? 'open' : ''}`}
          onMouseEnter={() => openHeaderMenu('help')}
        >
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

          {showStats && (
            <div className="viewport-cpu-box">
              <div className="viewport-cpu-label">CPU</div>
              <div className="viewport-cpu-value">
                {cpuStatus || 'CPU Usage: N/A (stats not available)'}
              </div>
            </div>
          )}

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

          <section className="converted-panel library-panel">
            <div className="library-panel-header">
              <div className="library-panel-title-wrap">
                <div className="library-panel-icon">
                  <LibraryBig size={18} strokeWidth={2} />
                </div>
                <div>
                  <div className="library-panel-title">Library</div>
                  <div className="library-panel-subtitle">All converted effects live here. Downloaded items are highlighted.</div>
                </div>
              </div>
              <div className="library-panel-count">{libraryEntries.length}</div>
            </div>
            {libraryEntries.length === 0 ? (
              <div className="library-empty-state">
                You do not have any library effects yet.
              </div>
            ) : (
              <div className="converted-list">
                {unlockedLibraryEntries.length > 0 ? (
                  <>
                    <div className="library-section-label">Purchased</div>
                    {unlockedLibraryEntries.map((item) => renderLibraryItem(item, true))}
                  </>
                ) : null}
                {loadedLibraryEntries.length > 0 ? (
                  <>
                    <div className="library-section-label">Downloaded</div>
                    {loadedLibraryEntries.map((item) => renderLibraryItem(item, false))}
                  </>
                ) : null}
              </div>
            )}
          </section>

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

      {showCanvasResetModal && pendingRuntimeConfig ? (
        <div className="modal-overlay" onClick={cancelCanvasReset}>
          <div className="modal-content canvas-reset-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Restart Renderer?</h2>
              <button className="modal-close" onClick={cancelCanvasReset}>×</button>
            </div>
            <div className="modal-body">
              <p>These changes require restarting the renderer.</p>
              {pendingRuntimeChanges.length > 0 ? (
                <ul className="canvas-reset-change-list">
                  {pendingRuntimeChanges.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={cancelCanvasReset}>Keep Current</button>
              <button className="btn-primary" onClick={confirmCanvasReset}>Restart Canvas</button>
            </div>
          </div>
        </div>
      ) : null}

      {showDepsPrompt ? (
        <div
          className="deps-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Select dependency folder"
          onClick={openDepsPicker}
        >
          <div className="deps-modal" onClick={(event) => event.stopPropagation()}>
            <div className="deps-modal-title">
              Dependency Folder Required: {depsPromptSource || sourceFile?.name || 'effect'}
            </div>
            <div className="deps-modal-copy">
              This effect references external resources. Choose the folder that contains its textures, models, materials, or sounds.
            </div>
            <div className="convert-progress-bar" aria-hidden="true">
              <span />
            </div>
            <div className="deps-modal-actions">
              <button
                type="button"
                className="conv-btn primary"
                onClick={openDepsPicker}
              >
                Choose Dependency Folder
              </button>
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
