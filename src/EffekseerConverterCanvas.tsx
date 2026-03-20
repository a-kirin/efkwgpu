import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { Check, CircleUserRound, LibraryBig, Sparkles } from 'lucide-react'
import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import './App.css'
import {
  EffekseerRenderPass,
  type EffekseerContext,
  type EffekseerHandle,
} from 'three-effekseer'
import {
  deleteAccountArtifact,
  consumeUnlockCredit,
  createCreditPackCheckoutSession,
  FunctionApiError,
  getCurrentAccountSnapshot,
  loadAccountArtifactBytes,
  registerConvertedArtifact,
  sha256Hex,
  signInWithGoogle,
  signOutCurrentUser,
  startEffectConversion,
  subscribeToAccountState,
  usesLocalStartEffectConversion,
  type AccountArtifactRecord,
  type AccountUserRecord,
  type AuthUserRecord,
  type CreditPackId,
  type StartEffectConversionResult,
} from './lib/firestoreUsers'
import { CREDIT_PACKS } from './billing/creditPacks'

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
    onerror?: (message: string, path: string) => void,
    redirect?: (resolvedPath: string) => string
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
  pendingPreviewEffect: ExtendedEffekseerEffect | null
  previewResourceCleanup: (() => void) | null
  builtInEffects: Map<string, ExtendedEffekseerEffect>
  activeEffectId: string | null
}

type RuntimeConfig = {
  mode: 'basic' | 'composite'
  hdrOutput: boolean
  outputColorSpace: 'srgb' | 'linear'
  antialias: boolean
  instanceMaxCount: number
  squareMaxCount: number
}

type ViewMode = '3d' | 'xy'

type PersistedUiSettings = {
  sidebarCollapsed: boolean
  viewMode: ViewMode
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

type LocalConvertedPackage = Omit<StartEffectConversionResult, 'bytes' | 'artifactId'> & {
  bytes: Uint8Array | null
  artifactId?: string | null
  artifactSha256: string
  artifactBytesLength: number
  sourceKind: 'converted' | 'direct'
  dependencyFiles?: DependencyImportFile[]
}

type DependencyImportFile = {
  file: File
  relativePath: string
}

type FileSystemHandleLike = {
  kind: 'file' | 'directory'
  name: string
}

type PickerStartIn = FileSystemHandleLike | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'

type FileSystemFileHandleLike = FileSystemHandleLike & {
  kind: 'file'
  getFile: () => Promise<File>
  createWritable?: () => Promise<FileSystemWritableFileStreamLike>
}

type FileSystemWritableFileStreamLike = {
  write: (data: Blob | BufferSource | string) => Promise<void>
  close: () => Promise<void>
}

type FileSystemDirectoryHandleLike = FileSystemHandleLike & {
  kind: 'directory'
  entries: () => AsyncIterableIterator<[string, FileSystemHandleLike]>
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite'; id?: string; startIn?: PickerStartIn }) => Promise<FileSystemDirectoryHandleLike>
  showOpenFilePicker?: (options?: {
    id?: string
    multiple?: boolean
    excludeAcceptAllOption?: boolean
    startIn?: PickerStartIn
    types?: Array<{
      description?: string
      accept: Record<string, string[]>
    }>
  }) => Promise<FileSystemFileHandleLike[]>
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: Array<{
      description?: string
      accept: Record<string, string[]>
    }>
  }) => Promise<FileSystemFileHandleLike>
}

type UnlockTarget =
  | {
      kind: 'session'
      item: LocalConvertedPackage
      accountArtifact: AccountArtifactRecord | null
    }
  | {
      kind: 'account'
      artifact: AccountArtifactRecord
    }

type CheckoutResumeState = {
  baselineCredits: number
  lastCreditGrantOrderId: string | null
  artifactId: string | null
  filename: string | null
}

type DeleteArtifactDialogState = {
  artifact: AccountArtifactRecord
}

type IconProps = {
  size?: number
}

type MenuCheckLabelProps = {
  label: string
  checked?: boolean
  description?: string
}

const BUILTIN_SAMPLE_BASE = '/pkmoves'

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
  { id: 'aurahdr', label: 'aurahdr.efkwgpk', path: `${BUILTIN_SAMPLE_BASE}/aurahdr.efkwgpk`, note: 'aura package sample' },
  { id: 'bloodpkg', label: 'blood.efkwgpk', path: `${BUILTIN_SAMPLE_BASE}/blood.efkwgpk`, note: 'blood package sample' },
  { id: 'shadowball', label: 'shadowball.efkwgpk', path: `${BUILTIN_SAMPLE_BASE}/shadowball.efkwgpk`, note: 'shadowball package sample' },
  { id: 'laser02', label: 'Laser02.efkwg', path: `${BUILTIN_SAMPLE_BASE}/Laser02.efkwg`, note: 'laser sample' },
  { id: 'testpkg', label: 'test.efkwgpk', path: `${BUILTIN_SAMPLE_BASE}/test.efkwgpk`, note: 'test package sample' },
]

const BUILTIN_IDS = SAMPLE_EFFECTS.map((effect) => effect.id)
const TRIGGER_INDICES = [0, 1, 2, 3] as const
const CONVERTED_PREVIEW_SCALE = 1
const SAMPLE_LOOKUP = new Map(SAMPLE_EFFECTS.map((effect) => [effect.id, effect]))

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  mode: 'basic',
  hdrOutput: false,
  outputColorSpace: 'srgb',
  antialias: false,
  instanceMaxCount: 4000,
  squareMaxCount: 10000,
}

const DEFAULT_FLOOR_COLOR = '#505768'
const UI_SETTINGS_STORAGE_KEY = 'effekseer-webgpu-converter-ui'
const CREDIT_CHECKOUT_STORAGE_KEY = 'effekseer-credit-pack-checkout'
const CHECKOUT_WAIT_TIMEOUT_MS = 30_000
const PREVIEW_CONVERSION_BLOCKED_MESSAGE = 'This account cannot convert more effects until credits are purchased.'
const EFFEKSEER_RUNTIME_BASE = (() => {
  const raw = (import.meta.env.VITE_EFFEKSEER_RUNTIME_BASE || '/effekseer-runtime').trim()
  if (!raw) return '/effekseer-runtime'
  return raw.replace(/\/+$/, '')
})()
const EFFEKSEER_RUNTIME_WASM_URL = `${EFFEKSEER_RUNTIME_BASE}/Effekseer_WebGPU_Runtime.wasm`

declare global {
  interface Window {
    __effekseerRuntimeLoadPromise__?: Promise<void>
  }
}

const loadScriptOnce = (src: string): Promise<void> => {
  const absoluteSrc = new URL(src, window.location.href).href
  const existing = Array.from(document.querySelectorAll('script')).find((script) => script.src === absoluteSrc)
  if (existing) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = absoluteSrc
    script.async = false
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load runtime script: ${src}`))
    document.head.appendChild(script)
  })
}

const ensureEffekseerRuntimeLoaded = async (): Promise<void> => {
  if (window.effekseer) return
  if (!window.__effekseerRuntimeLoadPromise__) {
    window.__effekseerRuntimeLoadPromise__ = (async () => {
      await loadScriptOnce(`${EFFEKSEER_RUNTIME_BASE}/fflate.umd.js`)
      await loadScriptOnce(`${EFFEKSEER_RUNTIME_BASE}/Effekseer_WebGPU_Runtime.js`)
      await loadScriptOnce(`${EFFEKSEER_RUNTIME_BASE}/effekseer.webgpu.src.js`)
      if (!window.effekseer) {
        throw new Error(`Effekseer runtime did not initialize from ${EFFEKSEER_RUNTIME_BASE}`)
      }
    })().catch((error) => {
      window.__effekseerRuntimeLoadPromise__ = undefined
      throw error
    })
  }
  await window.__effekseerRuntimeLoadPromise__
}

const getAppBaseUrl = (): string => {
  const configured = (import.meta.env.VITE_APP_BASE_URL || '').trim()
  if (configured) {
    return configured.replace(/\/$/, '')
  }
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}${window.location.pathname}`
}

const canAccountStartPreviewConversion = (accountUser: AccountUserRecord | null): boolean => {
  if (!accountUser) return false
  return accountUser.availableCredits > 0 || accountUser.freePreviewConversionsUsed < 5
}

const readMagicText = (bytes: ArrayBuffer | Uint8Array, length: number): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (view.byteLength < length) return ''
  const head = view.subarray(0, length)
  return String.fromCharCode(...head)
}

const toUint8Array = (bytes: ArrayBuffer | Uint8Array): Uint8Array => {
  if (bytes instanceof Uint8Array) return bytes
  return new Uint8Array(bytes)
}

const readMagicTag = (bytes: ArrayBuffer | Uint8Array): string => {
  const magic8 = readMagicText(bytes, 8)
  if (magic8) return magic8
  const magic4 = readMagicText(bytes, 4)
  return magic4
}

const isSupportedEffectMagic = (bytes: ArrayBuffer | Uint8Array): boolean => {
  const magic8 = readMagicText(bytes, 8)
  const magic4 = readMagicText(bytes, 4)
  return magic8 === 'EFWGPKG2' || magic4 === 'EFWG'
}

const describeMagic = (bytes: ArrayBuffer | Uint8Array): string => {
  const tag = readMagicTag(bytes)
  return tag || 'empty'
}

const createXYAxesGizmo = (size = 2.5): THREE.Group => {
  const group = new THREE.Group()
  group.name = 'XYAxesGizmo'

  const createAxisLine = (start: THREE.Vector3, end: THREE.Vector3, color: number) => new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([start, end]),
    new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      toneMapped: false,
      transparent: true,
    })
  )
  const xAxis = createAxisLine(new THREE.Vector3(0, 0, 0), new THREE.Vector3(size, 0, 0), 0xff5a5a)
  const yAxis = createAxisLine(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, size, 0), 0x5a7dff)
  xAxis.renderOrder = 1
  yAxis.renderOrder = 1
  group.add(xAxis, yAxis)

  return group
}

const applySceneViewMode = (
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  grid: THREE.GridHelper,
  floor: THREE.Mesh,
  viewMode: ViewMode
) => {
  if (viewMode === 'xy') {
    camera.fov = 45
    camera.zoom = 1
    camera.position.set(0, 0, 24)
    camera.up.set(0, 1, 0)
    controls.target.set(0, 0, 0)
    controls.enableRotate = false
    controls.screenSpacePanning = true
    grid.rotation.set(-Math.PI * 0.5, 0, 0)
    floor.rotation.set(0, 0, 0)
    floor.position.set(0, 0, -0.015)
  } else {
    camera.fov = 45
    camera.zoom = 1
    camera.position.set(9, 4.5, 9)
    camera.up.set(0, 1, 0)
    controls.target.set(0, 1, 0)
    controls.enableRotate = true
    controls.screenSpacePanning = true
    grid.rotation.set(0, 0, 0)
    floor.rotation.set(-Math.PI * 0.5, 0, 0)
    floor.position.set(0, -0.015, 0)
  }

  camera.lookAt(controls.target)
  camera.updateProjectionMatrix()
  controls.update()
}

let sharedWebGPUDevicePromise: Promise<GPUDevice> | null = null
let effekseerRuntimeInitialized = false

const createRuntimeState = (): RuntimeState => ({
  ctx: null,
  renderer: null,
  pass: null,
  handle: null,
  directEffect: null,
  pendingPreviewEffect: null,
  previewResourceCleanup: null,
  builtInEffects: new Map<string, ExtendedEffekseerEffect>(),
  activeEffectId: null,
})

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const isHandleAlive = (handle: ExtendedEffekseerHandle | null | undefined): boolean => {
  if (!handle) return false
  return handle.exists !== false
}

const isSupportedImportSource = (fileName: string): boolean => {
  const lower = fileName.toLowerCase()
  return (
    lower.endsWith('.efkefc') ||
    lower.endsWith('.efkpkg') ||
    lower.endsWith('.efkwg') ||
    lower.endsWith('.efkwgpk')
  )
}

const isDirectViewerSource = (fileName: string): boolean => {
  const lower = fileName.toLowerCase()
  return lower.endsWith('.efkwg') || lower.endsWith('.efkwgpk')
}

const requiresDependencyFolderPrompt = (fileName: string): boolean => {
  const lower = fileName.toLowerCase()
  return lower.endsWith('.efkefc') || lower.endsWith('.efkwg')
}

const SOURCE_PICKER_ID = 'effekseer-source-import'

const normalizeDependencyRelativePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\/+/, '')
const getFilenameExtension = (filename: string): string => {
  const index = filename.lastIndexOf('.')
  return index >= 0 ? filename.slice(index) : '.bin'
}

const normalizeResourceAliasPath = (path: string): string => {
  const normalized = String(path || '').replace(/\\/g, '/')
  const segments: string[] = []
  for (const raw of normalized.split('/')) {
    if (!raw || raw === '.') continue
    if (raw === '..') {
      if (segments.length > 0) segments.pop()
      continue
    }
    segments.push(raw.toLowerCase())
  }
  return segments.join('/')
}

const buildResourceAliases = (path: string): string[] => {
  if (!path) return []

  const normalized = String(path).replace(/\\/g, '/')
  const variants = [normalized]

  let withoutDot = normalized
  while (withoutDot.startsWith('./')) {
    withoutDot = withoutDot.slice(2)
  }
  if (withoutDot && withoutDot !== normalized) variants.push(withoutDot)

  const filename = normalized.split('/').pop() || ''
  if (filename && filename !== normalized) variants.push(filename)

  const addFolderHints = (value: string) => {
    if (!value || value.includes('/')) return
    const lower = value.toLowerCase()
    if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.dds') || lower.endsWith('.tga') || lower.endsWith('.bmp')) {
      variants.push(`Texture/${value}`)
      variants.push(`texture/${value}`)
    }
    if (lower.endsWith('.efkmodel') || lower.endsWith('.mqo')) {
      variants.push(`Model/${value}`)
      variants.push(`model/${value}`)
      variants.push(`mqo/${value}`)
    }
    if (lower.endsWith('.wav') || lower.endsWith('.ogg') || lower.endsWith('.mp3')) {
      variants.push(`Sound/${value}`)
      variants.push(`sound/${value}`)
    }
  }

  addFolderHints(filename)

  const segments: string[] = []
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0) segments.pop()
      continue
    }
    segments.push(segment)
  }
  for (let i = 0; i < segments.length; i++) {
    variants.push(segments.slice(i).join('/'))
  }

  const unique: string[] = []
  const seen = new Set<string>()
  for (const variant of variants) {
    const normalizedVariant = normalizeResourceAliasPath(variant)
    if (!normalizedVariant || seen.has(normalizedVariant)) continue
    seen.add(normalizedVariant)
    unique.push(normalizedVariant)
  }

  return unique
}

const stripResourceDecorations = (value: string): string => {
  const normalized = String(value || '').replace(/\\/g, '/')
  return normalized.split('#', 1)[0].split('?', 1)[0]
}

const createDependencyResourceBinding = (dependencyFiles: DependencyImportFile[]) => {
  const aliasToUrl = new Map<string, string>()
  const urls: string[] = []

  for (const dependency of dependencyFiles) {
    const url = URL.createObjectURL(dependency.file)
    urls.push(url)

    const seeds = [dependency.relativePath, dependency.file.name]
    for (const seed of seeds) {
      for (const alias of buildResourceAliases(seed)) {
        if (!aliasToUrl.has(alias)) {
          aliasToUrl.set(alias, url)
        }
      }
    }
  }

  return {
    redirect: (resolvedPath: string): string => {
      const candidatePath = stripResourceDecorations(resolvedPath)
      for (const alias of buildResourceAliases(candidatePath)) {
        const mapped = aliasToUrl.get(alias)
        if (mapped) {
          return mapped
        }
      }
      return resolvedPath
    },
    dispose: () => {
      for (const url of urls) {
        URL.revokeObjectURL(url)
      }
    },
  }
}

const shouldSkipDependencyCandidate = (source: File, entry: DependencyImportFile): boolean => {
  const candidateName = entry.relativePath.split('/').pop() || entry.file.name
  return candidateName.toLowerCase() === source.name.toLowerCase() && entry.file.size === source.size
}

const filterDependencyImportFiles = (source: File, entries: DependencyImportFile[]): DependencyImportFile[] => (
  entries.filter((entry) => !shouldSkipDependencyCandidate(source, entry))
)

const collectDependencyFilesFromDirectory = async (
  handle: FileSystemDirectoryHandleLike,
  prefix = ''
): Promise<DependencyImportFile[]> => {
  const files: DependencyImportFile[] = []

  for await (const [entryName, rawHandle] of handle.entries()) {
    if (!rawHandle || typeof rawHandle !== 'object') continue
    const relativePath = prefix ? `${prefix}/${entryName}` : entryName
    if (rawHandle.kind === 'directory') {
      files.push(...await collectDependencyFilesFromDirectory(rawHandle as FileSystemDirectoryHandleLike, relativePath))
      continue
    }
    if (rawHandle.kind !== 'file' || typeof (rawHandle as FileSystemFileHandleLike).getFile !== 'function') {
      continue
    }
    const file = await (rawHandle as FileSystemFileHandleLike).getFile()
    files.push({
      file,
      relativePath: normalizeDependencyRelativePath(relativePath),
    })
  }

  return files
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
  a.outputColorSpace === b.outputColorSpace &&
  a.antialias === b.antialias &&
  a.instanceMaxCount === b.instanceMaxCount &&
  a.squareMaxCount === b.squareMaxCount
)

const normalizeRuntimeConfig = (config: RuntimeConfig): RuntimeConfig => ({
  mode: config.mode,
  hdrOutput: config.hdrOutput,
  outputColorSpace: config.outputColorSpace === 'linear' ? 'linear' : 'srgb',
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
  if (current.outputColorSpace !== next.outputColorSpace) {
    changes.push(`Color Space: ${next.outputColorSpace === 'linear' ? 'Linear' : 'sRGB'}`)
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
    viewMode: '3d',
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
      viewMode: parsed.viewMode === 'xy' ? 'xy' : defaults.viewMode,
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
        outputColorSpace: runtimeCandidate.outputColorSpace === 'linear' || runtimeCandidate.outputColorSpace === 'srgb'
          ? runtimeCandidate.outputColorSpace
          : defaults.runtimeConfig.outputColorSpace,
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

const readCheckoutResumeState = (): CheckoutResumeState | null => {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.sessionStorage.getItem(CREDIT_CHECKOUT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CheckoutResumeState>
    return {
      baselineCredits: typeof parsed.baselineCredits === 'number' ? Math.trunc(parsed.baselineCredits) : 0,
      lastCreditGrantOrderId: typeof parsed.lastCreditGrantOrderId === 'string' && parsed.lastCreditGrantOrderId.trim()
        ? parsed.lastCreditGrantOrderId
        : null,
      artifactId: typeof parsed.artifactId === 'string' && parsed.artifactId.trim() ? parsed.artifactId : null,
      filename: typeof parsed.filename === 'string' && parsed.filename.trim() ? parsed.filename : null,
    }
  } catch {
    return null
  }
}

const writeCheckoutResumeState = (state: CheckoutResumeState) => {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(CREDIT_CHECKOUT_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore session storage failures.
  }
}

const clearCheckoutResumeState = () => {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(CREDIT_CHECKOUT_STORAGE_KEY)
  } catch {
    // Ignore session storage failures.
  }
}

export default function EffekseerConverterCanvas() {
  const persistedUiSettingsRef = useRef<PersistedUiSettings | null>(null)
  if (persistedUiSettingsRef.current === null) {
    persistedUiSettingsRef.current = readPersistedUiSettings()
  }
  const persistedUiSettings = persistedUiSettingsRef.current

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const cubeRef = useRef<THREE.Mesh | null>(null)
  const gridRef = useRef<THREE.GridHelper | null>(null)
  const axesHelperRef = useRef<THREE.AxesHelper | null>(null)
  const xyAxesGizmoRef = useRef<THREE.Group | null>(null)
  const floorRef = useRef<THREE.Mesh | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const sourceInputRef = useRef<HTMLInputElement | null>(null)
  const depsInputRef = useRef<HTMLInputElement | null>(null)
  const menuBarRef = useRef<HTMLElement | null>(null)
  const profileMenuRef = useRef<HTMLDivElement | null>(null)
  const runtimeRef = useRef<RuntimeState>(createRuntimeState())
  const dependencyPromptTokenRef = useRef(0)
  const sourceHandleRef = useRef<FileSystemFileHandleLike | null>(null)

  const [runtimeReady, setRuntimeReady] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(persistedUiSettings.sidebarCollapsed)
  const [viewMode, setViewMode] = useState<ViewMode>(persistedUiSettings.viewMode)
  const [activeEffectId, setActiveEffectId] = useState('')
  const [playback, setPlayback] = useState<'stopped' | 'playing' | 'paused'>('stopped')
  const [error, setError] = useState('')
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [dependencyFiles, setDependencyFiles] = useState<DependencyImportFile[]>([])
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
  const [convertedList, setConvertedList] = useState<Array<LocalConvertedPackage>>([])
  const [convertedPackage, setConvertedPackage] = useState<LocalConvertedPackage | null>(null)
  const [, setConverterStatus] = useState('Choose or drop .efkefc, .efkpkg, .efkwg, or .efkwgpk')
  
  const [authUser, setAuthUser] = useState<AuthUserRecord | null>(null)
  const [accountUser, setAccountUser] = useState<AccountUserRecord | null>(null)
  const [accountArtifacts, setAccountArtifacts] = useState<AccountArtifactRecord[]>([])
  const [showUnlockModal, setShowUnlockModal] = useState<UnlockTarget | null>(null)
  const [showCreditPackModal, setShowCreditPackModal] = useState(false)
  const [showSignInPromptModal, setShowSignInPromptModal] = useState(false)
  const [signInPromptMessage, setSignInPromptMessage] = useState('Sign in with Google before continuing.')
  const [signInPending, setSignInPending] = useState(false)
  const [showDeleteArtifactModal, setShowDeleteArtifactModal] = useState<DeleteArtifactDialogState | null>(null)
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [runtimeConfigDraft, setRuntimeConfigDraft] = useState<RuntimeConfig>(persistedUiSettings.runtimeConfig)
  const [runtimeConfigApplied, setRuntimeConfigApplied] = useState<RuntimeConfig>(persistedUiSettings.runtimeConfig)
  const [showCanvasResetModal, setShowCanvasResetModal] = useState(false)
  const [pendingRuntimeConfig, setPendingRuntimeConfig] = useState<RuntimeConfig | null>(null)
  const [checkoutPending, setCheckoutPending] = useState(false)
  const [deletePending, setDeletePending] = useState(false)
  const [deleteError, setDeleteError] = useState('')

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
      viewMode,
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
    viewMode,
    showFloor,
    showGrid,
    showSamplesList,
    showSceneCube,
    showStats,
    sidebarCollapsed,
  ])

  const reportFirebaseError = useCallback((label: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setError(`${label}: ${message}`)
  }, [])

  useEffect(() => {
    return subscribeToAccountState(
      (state) => {
        setAuthUser(state.authUser)
        setAccountUser(state.account)
        setAccountArtifacts(state.artifacts)
      },
      (message) => {
        setError(message)
      }
    )
  }, [])

  useEffect(() => {
    if (!authUser) return
    setShowSignInPromptModal(false)
  }, [authUser])

  const downloadViaAnchor = useCallback((url: string, filename: string) => {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.rel = 'noopener'
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }, [])

  const saveBlobToPickedLocation = useCallback(async (blob: Blob, filename: string): Promise<boolean> => {
    const pickerWindow = window as DirectoryPickerWindow
    if (typeof pickerWindow.showSaveFilePicker !== 'function') {
      return false
    }

    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'Effekseer files',
            accept: {
              'application/octet-stream': [getFilenameExtension(filename)],
            },
          },
        ],
      })
      if (!handle.createWritable) {
        return false
      }
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return true
    } catch (error) {
      const errorName = error instanceof DOMException ? error.name : ''
      if (errorName === 'AbortError') {
        return true
      }
      throw error
    }
  }, [])

  const downloadRemoteArtifact = useCallback(async (downloadUrl: string, filename: string) => {
    try {
      const response = await fetch(downloadUrl)
      if (!response.ok) {
        throw new Error(`Download failed with HTTP ${response.status}`)
      }
      const blob = await response.blob()
      const saved = await saveBlobToPickedLocation(blob, filename)
      if (saved) return

      const objectUrl = URL.createObjectURL(blob)
      downloadViaAnchor(objectUrl, filename)
      URL.revokeObjectURL(objectUrl)
    } catch {
      downloadViaAnchor(downloadUrl, filename)
    }
  }, [downloadViaAnchor, saveBlobToPickedLocation])

  const downloadLocalArtifact = useCallback(async (bytes: Uint8Array, filename: string) => {
    const payload = new Uint8Array(bytes.byteLength)
    payload.set(bytes)
    const blob = new Blob([payload.buffer], {
      type: 'application/octet-stream',
    })
    const saved = await saveBlobToPickedLocation(blob, filename)
    if (saved) return

    const objectUrl = URL.createObjectURL(blob)
    downloadViaAnchor(objectUrl, filename)
    URL.revokeObjectURL(objectUrl)
  }, [downloadViaAnchor, saveBlobToPickedLocation])

  const openSignInPrompt = useCallback((message: string) => {
    setShowProfileMenu(false)
    setSignInPromptMessage(message)
    setShowSignInPromptModal(true)
  }, [])

  const handleGooglePromptSignIn = useCallback(async () => {
    setSignInPending(true)
    setError('')
    try {
      const completed = await signInWithGoogle()
      if (completed) {
        setShowSignInPromptModal(false)
      }
    } catch (error) {
      reportFirebaseError('Unable to sign in', error)
    } finally {
      setSignInPending(false)
    }
  }, [reportFirebaseError])

  const ensureSignedInForPremiumAction = useCallback(async (): Promise<boolean> => {
    if (authUser) return true
    openSignInPrompt('You need to sign in with Google before continuing.')
    return false
  }, [authUser, openSignInPrompt])

  const removeConvertedPackageByOutputName = useCallback((outputName: string) => {
    setConvertedList((prev) => prev.filter((item) => item.outputName !== outputName))
    if (convertedPackage?.outputName === outputName) {
      const runtime = runtimeRef.current
      if (runtime.ctx?.releaseEffect && runtime.directEffect) {
        try {
          runtime.ctx.releaseEffect(runtime.directEffect)
        } catch {
          // Ignore stale release failures during teardown.
        }
      }
      runtime.directEffect = null
      setConvertedPackage(null)
      setPlayback('stopped')
    }
  }, [convertedPackage?.outputName])

  const registerArtifactForItem = useCallback(async (item: LocalConvertedPackage) => {
    if (item.artifactId) {
      return {
        artifactId: item.artifactId,
        sha256: item.artifactSha256,
      }
    }
    if (!(item.bytes instanceof Uint8Array)) {
      throw new Error(`Artifact bytes are not available for ${item.outputName}.`)
    }

    const registration = await registerConvertedArtifact({
      outputName: item.outputName,
      sourceName: sourceFile?.name || item.outputName,
      bytes: item.bytes,
    })

    setConvertedList((prev) => prev.map((entry) => (
      entry.outputName === item.outputName
        ? {
            ...entry,
            artifactId: registration.artifactId,
            artifactSha256: registration.sha256,
            artifactBytesLength: registration.bytesLength,
          }
        : entry
    )))
    setConvertedPackage((current) => (
      current && current.outputName === item.outputName
        ? {
            ...current,
            artifactId: registration.artifactId,
            artifactSha256: registration.sha256,
            artifactBytesLength: registration.bytesLength,
          }
        : current
    ))

    return {
      artifactId: registration.artifactId,
      sha256: registration.sha256,
    }
  }, [sourceFile])

  const upsertLocalConvertedPackage = useCallback((nextItem: LocalConvertedPackage) => {
    setConvertedList((prev) => {
      const nextIndex = prev.findIndex((item) => (
        (!!nextItem.artifactId && item.artifactId === nextItem.artifactId) ||
        (!!nextItem.artifactSha256 && item.artifactSha256 === nextItem.artifactSha256) ||
        item.outputName === nextItem.outputName
      ))
      if (nextIndex < 0) return [...prev, nextItem]
      const clone = prev.slice()
      clone[nextIndex] = nextItem
      return clone
    })
    setConvertedPackage(nextItem)
  }, [])

  const runCreditPackCheckout = useCallback(async (packId: CreditPackId, target: UnlockTarget | null) => {
    const latestAccount = await getCurrentAccountSnapshot()
    if (latestAccount) {
      setAccountUser(latestAccount)
    }

    let artifactId: string | null = null
    let filename: string | null = null

    if (target?.kind === 'session') {
      if (target.accountArtifact) {
        artifactId = target.accountArtifact.artifactId
        filename = target.accountArtifact.outputName
      } else {
        const registration = await registerArtifactForItem(target.item)
        artifactId = registration.artifactId
        filename = target.item.outputName
      }
    } else if (target?.kind === 'account') {
      artifactId = target.artifact.artifactId
      filename = target.artifact.outputName
    }

    writeCheckoutResumeState({
      baselineCredits: latestAccount?.creditsBalance ?? accountUser?.creditsBalance ?? 0,
      lastCreditGrantOrderId: latestAccount?.lastCreditGrantOrderId ?? accountUser?.lastCreditGrantOrderId ?? null,
      artifactId,
      filename,
    })

    const appBaseUrl = getAppBaseUrl()
    const returnUrl = `${appBaseUrl}?checkout=success`
    const { checkoutUrl } = await createCreditPackCheckoutSession({
      packId,
      returnUrl,
      artifactId: artifactId || undefined,
    })
    window.location.assign(checkoutUrl)
  }, [accountUser, registerArtifactForItem])

  const handleSignIn = useCallback(async () => {
    openSignInPrompt('Sign in with Google to continue.')
  }, [openSignInPrompt])

  const handleOpenCreditPackModal = useCallback(async () => {
    setShowProfileMenu(false)
    try {
      const completed = await ensureSignedInForPremiumAction()
      if (!completed) return
      setShowCreditPackModal(true)
    } catch (error) {
      reportFirebaseError('Unable to start credit purchase', error)
    }
  }, [ensureSignedInForPremiumAction, reportFirebaseError])

  const handleSignOut = useCallback(async () => {
    setShowProfileMenu(false)
    setShowCreditPackModal(false)
    setShowDeleteArtifactModal(null)
    try {
      await signOutCurrentUser()
    } catch (error) {
      reportFirebaseError('Unable to sign out', error)
    }
  }, [reportFirebaseError])

  const handleCreditPackPurchase = useCallback(async (packId: CreditPackId, target: UnlockTarget | null) => {
    try {
      const isSignedIn = await ensureSignedInForPremiumAction()
      if (!isSignedIn) return

      setCheckoutPending(true)
      setShowCreditPackModal(false)
      await runCreditPackCheckout(packId, target)
    } catch (error) {
      clearCheckoutResumeState()
      reportFirebaseError('Unable to purchase credits', error)
      setCheckoutPending(false)
    }
  }, [ensureSignedInForPremiumAction, reportFirebaseError, runCreditPackCheckout])

  const handleUnlockDownload = useCallback(async (target: UnlockTarget) => {
    try {
      const isSignedIn = await ensureSignedInForPremiumAction()
      if (!isSignedIn) return

      let artifactId = ''
      let filename = ''

      if (target.kind === 'session') {
        if (target.accountArtifact) {
          artifactId = target.accountArtifact.artifactId
          filename = target.accountArtifact.outputName
        } else {
          const registration = await registerArtifactForItem(target.item)
          artifactId = registration.artifactId
          filename = target.item.outputName
        }
      } else {
        artifactId = target.artifact.artifactId
        filename = target.artifact.outputName
      }

      const result = await consumeUnlockCredit(artifactId)
      setAccountUser((current) => current ? {
        ...current,
        creditsBalance: result.creditsBalance,
        availableCredits: Math.max(0, result.creditsBalance),
      } : current)
      await downloadRemoteArtifact(result.downloadUrl, filename)
      setShowUnlockModal(null)
    } catch (error) {
      reportFirebaseError('Unable to unlock download', error)
    }
  }, [
    downloadRemoteArtifact,
    ensureSignedInForPremiumAction,
    registerArtifactForItem,
    reportFirebaseError,
  ])

  const handleConfirmDeleteArtifact = useCallback(async () => {
    if (!showDeleteArtifactModal) return

    const { artifact } = showDeleteArtifactModal
    setDeletePending(true)
    setDeleteError('')

    try {
      await deleteAccountArtifact(artifact.artifactId)

      const localMatch = convertedList.find((item) => (
        (!!item.artifactId && item.artifactId === artifact.artifactId) ||
        (!!item.artifactSha256 && item.artifactSha256 === artifact.sha256)
      )) ?? null

      if (localMatch) {
        removeConvertedPackageByOutputName(localMatch.outputName)
      }

      if (showUnlockModal) {
        const modalArtifactId = showUnlockModal.kind === 'account'
          ? showUnlockModal.artifact.artifactId
          : showUnlockModal.accountArtifact?.artifactId ?? null
        if (modalArtifactId === artifact.artifactId) {
          setShowUnlockModal(null)
        }
      }

      setShowDeleteArtifactModal(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setDeleteError(message)
    } finally {
      setDeletePending(false)
    }
  }, [
   
    convertedList,
    removeConvertedPackageByOutputName,
    showDeleteArtifactModal,
    showUnlockModal,
  ])

  useEffect(() => {
    if (accountArtifacts.length === 0) return

    setConvertedList((prev) => prev.map((item) => {
      const match = item.artifactId
        ? accountArtifacts.find((artifact) => artifact.artifactId === item.artifactId)
        : item.artifactSha256
          ? accountArtifacts.find((artifact) => artifact.sha256 === item.artifactSha256)
          : null

      if (!match) return item
      return {
        ...item,
        artifactId: match.artifactId,
        artifactSha256: match.sha256,
        artifactBytesLength: match.bytesLength,
      }
    }))

    setConvertedPackage((current) => {
      if (!current) return current
      const match = current.artifactId
        ? accountArtifacts.find((artifact) => artifact.artifactId === current.artifactId)
        : current.artifactSha256
          ? accountArtifacts.find((artifact) => artifact.sha256 === current.artifactSha256)
          : null
      if (!match) return current
      return {
        ...current,
        artifactId: match.artifactId,
        artifactSha256: match.sha256,
        artifactBytesLength: match.bytesLength,
      }
    })
  }, [accountArtifacts])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const params = new URLSearchParams(window.location.search)
    if (params.get('checkout') !== 'success') return

    const checkoutResumeState = readCheckoutResumeState()
    const startedAt = Date.now()
    let cancelled = false

    const baselineCredits = checkoutResumeState?.baselineCredits ?? (accountUser?.creditsBalance ?? 0)
    const baselineOrderId = checkoutResumeState?.lastCreditGrantOrderId ?? accountUser?.lastCreditGrantOrderId ?? null

    const cleanupCheckoutUrl = () => {
      params.delete('checkout')
      params.delete('artifactId')
      const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}${window.location.hash}`
      window.history.replaceState({}, '', nextUrl)
      clearCheckoutResumeState()
    }

    const poll = async () => {
      while (!cancelled && Date.now() - startedAt < CHECKOUT_WAIT_TIMEOUT_MS) {
        const latestAccount = await getCurrentAccountSnapshot()
        if (latestAccount) {
          setAccountUser(latestAccount)
        }

        const creditGrantDetected = !!latestAccount && (
          latestAccount.creditsBalance > baselineCredits ||
          latestAccount.lastCreditGrantOrderId !== baselineOrderId
        )

        if (creditGrantDetected) {
          cleanupCheckoutUrl()

          if (checkoutResumeState?.artifactId && checkoutResumeState.filename) {
            try {
              const result = await consumeUnlockCredit(checkoutResumeState.artifactId)
              setAccountUser((current) => current ? {
                ...current,
                creditsBalance: result.creditsBalance,
                availableCredits: Math.max(0, result.creditsBalance),
              } : current)
              await downloadRemoteArtifact(result.downloadUrl, checkoutResumeState.filename)
            } catch (error) {
              reportFirebaseError('Unable to resume unlock after credit purchase', error)
            }
          }

          return
        }

        await new Promise((resolve) => window.setTimeout(resolve, 1000))
      }

      cleanupCheckoutUrl()
    }

    void poll()

    return () => {
      cancelled = true
    }
  }, [accountUser,  downloadRemoteArtifact, reportFirebaseError])

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
    runtime.pendingPreviewEffect = null
    if (runtime.previewResourceCleanup) {
      try {
        runtime.previewResourceCleanup()
      } catch {
        // Ignore stale object URL cleanup failures.
      }
    }
    runtime.previewResourceCleanup = null
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
      return false
    }

    runtime.handle = handle
    runtime.directEffect = effect
    runtime.activeEffectId = effectId
    setActiveEffectId(effectId)
    setPlayback('playing')
    setError('')
    return true
  }, [])

  const playRegisteredEffect = useCallback(async (effectId: string) => {
    const runtime = runtimeRef.current
    const ctx = runtime.ctx
    if (!ctx) return false

    try {
      clearConvertedRegistration()
      runtime.handle?.stop()
      ctx.stopAll()

      const sample = SAMPLE_LOOKUP.get(effectId)
      if (!sample) {
        throw new Error(`Unknown sample id: ${effectId}`)
      }
      if (!ctx.loadEffect || !ctx.play) {
        throw new Error('Runtime context does not expose loadEffect()/play() APIs.')
      }

      let effect = runtime.builtInEffects.get(effectId) ?? null
      if (!effect) {
        const loadWithContext = (data: string | Uint8Array, label: string) => new Promise<ExtendedEffekseerEffect>((resolve, reject) => {
          let requestedEffect: ExtendedEffekseerEffect | null = null
          requestedEffect = ctx.loadEffect!(
            data,
            1,
            () => resolve(requestedEffect!),
            (message: string, path: string) => reject(new Error(path ? `${message} (${path})` : message || `failed to load ${label}`))
          )
          if (!requestedEffect) {
            reject(new Error(`loadEffect returned null for ${label}`))
          }
        })

        const candidates = Array.from(new Set([
          sample.path,
          `${EFFEKSEER_RUNTIME_BASE}/${sample.label}`,
        ]))
        const candidateErrors: string[] = []

        for (const candidate of candidates) {
          try {
            effect = await loadWithContext(candidate, candidate)
            break
          } catch (loadError) {
            const message = loadError instanceof Error ? loadError.message : String(loadError)
            candidateErrors.push(`${candidate} -> ${message}`)
          }
        }

        let sampleBytes: Uint8Array | null = null
        const fetchErrors: string[] = []

        if (!effect) {
          for (const candidate of candidates) {
            const response = await fetch(candidate)
            if (!response.ok) {
              fetchErrors.push(`${candidate} -> HTTP ${response.status}`)
              continue
            }

            const bytes = toUint8Array(await response.arrayBuffer())
            const valid = isSupportedEffectMagic(bytes)
            if (!valid) {
              fetchErrors.push(`${candidate} -> invalid magic (${describeMagic(bytes)})`)
              continue
            }

            sampleBytes = bytes
            break
          }
        }

        if (!effect && !sampleBytes) {
          throw new Error(
            `Failed to load ${sample.label}. ${candidateErrors.join(' | ')}${fetchErrors.length ? ` | ${fetchErrors.join(' | ')}` : ''}`
          )
        }

        if (!effect && sampleBytes) {
          effect = await loadWithContext(sampleBytes, `${sample.label} (bytes)`)
        }

        if (!effect) {
          throw new Error(`Effect "${sample.label}" failed to initialize.`)
        }
        runtime.builtInEffects.set(effectId, effect)
      }

      if (!effect.isLoaded) {
        throw new Error(`Effect "${sample.label}" did not finish loading.`)
      }
      const handle = ctx.play(effect, 0, 0, 0) as ExtendedEffekseerHandle | null
      if (!handle) {
        throw new Error(`play("${sample.label}") returned null.`)
      }

      runtime.handle = handle
      runtime.activeEffectId = effectId
      setActiveEffectId(effectId)
      setPlayback('playing')
      setError('')
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setPlayback('stopped')
      setError(message)
      return false
    }
  }, [clearConvertedRegistration])

  const loadConvertedPreview = useCallback(async (pkg: LocalConvertedPackage) => {
    const runtime = runtimeRef.current
    const ctx = runtime.ctx
    if (!ctx?.loadEffect) return
    if (!(pkg.bytes instanceof Uint8Array) || pkg.bytes.byteLength === 0) {
      throw new Error('Preview disabled for locked conversions. Unlock the artifact to download it.')
    }
    const previewBytes = pkg.bytes
    const dependencyBinding = pkg.dependencyFiles && pkg.dependencyFiles.length > 0
      ? createDependencyResourceBinding(pkg.dependencyFiles)
      : null

    clearConvertedRegistration()
    runtime.handle?.stop()
    ctx.stopAll()
    runtime.previewResourceCleanup = dependencyBinding?.dispose ?? null

    const effect = await new Promise<ExtendedEffekseerEffect>((resolve, reject) => {
      let requestedEffect: ExtendedEffekseerEffect | null = null
      let settled = false
      const probeTimerIds: number[] = []
      const timeoutId = window.setTimeout(() => {
        if (settled) return
        settled = true
        for (const timerId of probeTimerIds) window.clearTimeout(timerId)
        reject(new Error(`Timed out while loading preview "${pkg.outputName}".`))
      }, 15000)

      const finishResolve = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timeoutId)
        for (const timerId of probeTimerIds) window.clearTimeout(timerId)
        runtime.pendingPreviewEffect = null
        resolve(requestedEffect!)
      }

      const finishReject = (error: Error) => {
        if (settled) return
        settled = true
        window.clearTimeout(timeoutId)
        for (const timerId of probeTimerIds) window.clearTimeout(timerId)
        runtime.pendingPreviewEffect = null
        reject(error)
      }

      requestedEffect = ctx.loadEffect!(
        toArrayBuffer(previewBytes),
        CONVERTED_PREVIEW_SCALE,
        () => {
          finishResolve()
        },
        (message: string, path: string) => {
          const errorMessage = path ? `${message} (${path})` : message
          finishReject(new Error(errorMessage))
        },
        dependencyBinding?.redirect
      )
      if (!requestedEffect) {
        finishReject(new Error('loadEffect(bytes) returned null.'))
        return
      }
      runtime.pendingPreviewEffect = requestedEffect
      for (const waitMs of [0, 50, 250, 1000, 4000]) {
        const timerId = window.setTimeout(() => {
          if (settled) return
        }, waitMs)
        probeTimerIds.push(timerId)
      }
    })
    if (!effect.isLoaded) {
      throw new Error(`Converted effect "${pkg.outputName}" did not finish loading.`)
    }

    setConverterStatus(`Preview ready: ${pkg.outputName}`)
    playDirectEffect(effect, 'converted-preview', pkg.outputName)
  }, [clearConvertedRegistration, playDirectEffect])

  const loadAccountArtifactPreview = useCallback(async (artifact: AccountArtifactRecord) => {
    try {
      const localMatch = convertedList.find((item) => (
        (!!item.artifactId && item.artifactId === artifact.artifactId) ||
        (!!item.artifactSha256 && item.artifactSha256 === artifact.sha256)
      )) ?? null

      if (localMatch?.bytes) {
        upsertLocalConvertedPackage(localMatch)
        await loadConvertedPreview(localMatch)
        return
      }

      if (artifact.unlockStatus !== 'unlocked') {
        setConverterStatus(`Preview locked: ${artifact.outputName}`)
        return
      }

      setLoadingMessage(`Loading library effect: ${artifact.outputName}`)
      const loaded = await loadAccountArtifactBytes(artifact.artifactId)
      const bytes = loaded.bytes
      const resolvedSha256 = loaded.sha256 || artifact.sha256 || await sha256Hex(bytes)
      const pkg: LocalConvertedPackage = {
        artifactId: artifact.artifactId,
        alreadyExisted: true,
        bytes,
        outputName: artifact.outputName,
        mainEffectPath: artifact.outputName,
        bytesLength: bytes.byteLength,
        sha256: resolvedSha256,
        status: 'completed',
        artifactSha256: resolvedSha256,
        artifactBytesLength: bytes.byteLength,
        sourceKind: 'converted',
        dependencyFiles: [],
      }

      upsertLocalConvertedPackage(pkg)
      setConverterStatus(`Loaded ${artifact.outputName} ${(bytes.byteLength / 1024).toFixed(1)} KB`)
      await loadConvertedPreview(pkg)
    } finally {
      setLoadingMessage('')
    }
  }, [
    convertedList,
    loadConvertedPreview,
    loadAccountArtifactBytes,
    upsertLocalConvertedPackage,
  ])

  const downloadUnlockedAccountArtifact = useCallback(async (artifact: AccountArtifactRecord) => {
    const localMatch = convertedList.find((item) => (
      (!!item.artifactId && item.artifactId === artifact.artifactId) ||
      (!!item.artifactSha256 && item.artifactSha256 === artifact.sha256)
    )) ?? null

    if (localMatch?.bytes) {
      await downloadLocalArtifact(localMatch.bytes, artifact.outputName)
      return
    }

    try {
      setLoadingMessage(`Preparing download: ${artifact.outputName}`)
      const loaded = await loadAccountArtifactBytes(artifact.artifactId)
      const bytes = loaded.bytes
      const resolvedSha256 = loaded.sha256 || artifact.sha256 || await sha256Hex(bytes)
      upsertLocalConvertedPackage({
        artifactId: artifact.artifactId,
        alreadyExisted: true,
        bytes,
        outputName: artifact.outputName,
        mainEffectPath: artifact.outputName,
        bytesLength: bytes.byteLength,
        sha256: resolvedSha256,
        status: 'completed',
        artifactSha256: resolvedSha256,
        artifactBytesLength: bytes.byteLength,
        sourceKind: 'converted',
        dependencyFiles: [],
      })
      await downloadLocalArtifact(bytes, artifact.outputName)
    } finally {
      setLoadingMessage('')
    }
  }, [
    convertedList,
    downloadLocalArtifact,
    loadAccountArtifactBytes,
    upsertLocalConvertedPackage,
  ])

  useEffect(() => {
    if (cubeRef.current) {
      cubeRef.current.visible = showSceneCube
    }
  }, [showSceneCube])

  useEffect(() => {
    const grid = gridRef.current
    if (grid) grid.visible = showGrid
    const axesHelper = axesHelperRef.current
    if (axesHelper) axesHelper.visible = showGrid && viewMode === '3d'
    const xyAxesGizmo = xyAxesGizmoRef.current
    if (xyAxesGizmo) xyAxesGizmo.visible = showGrid && viewMode === 'xy'
  }, [showGrid, viewMode])

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

  useEffect(() => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    const grid = gridRef.current
    const floor = floorRef.current
    if (!camera || !controls || !grid || !floor) return

    applySceneViewMode(camera, controls, grid, floor, viewMode)
  }, [viewMode])

  const resetView = useCallback(() => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    const grid = gridRef.current
    const floor = floorRef.current
    if (camera && controls && grid && floor) {
      applySceneViewMode(camera, controls, grid, floor, viewMode)
    }
    setShowSceneCube(false)
    setShowGrid(true)
    setShowFloor(false)
    setBgColor('#000000')
    setGridColor('#ffffff')
    setFloorColor(DEFAULT_FLOOR_COLOR)
  }, [viewMode])

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
    if (!canvas || !('gpu' in navigator)) {
      setError('WebGPU is not available in this page.')
      return
    }
    let effekseerApi = window.effekseer

    let cancelled = false
    let frame = 0
    const timer = new THREE.Timer()
    timer.connect(document)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(bgColor)
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    cameraRef.current = camera

    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.dampingFactor = 0.08

    const grid = new THREE.GridHelper(20, 10, gridColor, gridColor)
    if (!Array.isArray(grid.material)) {
      grid.material.vertexColors = false
      grid.material.color.set(gridColor)
      grid.material.needsUpdate = true
    }
    const axesHelper = new THREE.AxesHelper(2.5)
    if (!Array.isArray(axesHelper.material)) {
      axesHelper.material.depthTest = false
      axesHelper.material.toneMapped = false
      axesHelper.material.transparent = true
    }
    axesHelper.renderOrder = 1
    axesHelper.visible = showGrid && viewMode === '3d'
    const xyAxesGizmo = createXYAxesGizmo(2.5)
    xyAxesGizmo.visible = showGrid && viewMode === 'xy'
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
    axesHelperRef.current = axesHelper
    xyAxesGizmoRef.current = xyAxesGizmo
    floorRef.current = floor
    controlsRef.current = controls
    applySceneViewMode(camera, controls, grid, floor, viewMode)
    scene.add(floor, grid, axesHelper, xyAxesGizmo, cube)

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
      if (!pass) {
        return
      }

      const handle = runtimeRef.current.handle
      const handleAlive = isHandleAlive(handle)
      if (handle && !handleAlive) {
        runtimeRef.current.handle = null
        setPlayback((prev) => (prev === 'stopped' ? prev : 'stopped'))
      }

      timer.update(time)
      const deltaFrames = Math.max(0, timer.getDelta() * 60)
      if (cube.visible) {
        cube.rotation.y += 0.01
        cube.rotation.z += 0.01
      }
      controls.update()
      pass.render(deltaFrames)

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

    const disposeAxesHelper = () => {
      axesHelper.geometry.dispose()
      if (Array.isArray(axesHelper.material)) {
        for (const entry of axesHelper.material) {
          entry.dispose()
        }
        return
      }
      axesHelper.material.dispose()
    }

    const disposeXYAxesGizmo = () => {
      xyAxesGizmo.traverse((child) => {
        const meshChild = child as THREE.Object3D & {
          geometry?: THREE.BufferGeometry
          material?: THREE.Material | THREE.Material[]
        }
        meshChild.geometry?.dispose()
        if (Array.isArray(meshChild.material)) {
          for (const entry of meshChild.material) {
            entry.dispose()
          }
        } else {
          meshChild.material?.dispose()
        }
      })
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
      const runtimeApi = effekseerApi ?? window.effekseer
      runtimeApi?.releaseContext?.(runtime.ctx)
      runtime.pass?.dispose()
      geometry.dispose()
      material.dispose()
      disposeGrid()
      disposeAxesHelper()
      disposeXYAxesGizmo()
      disposeFloor()
      controls.dispose()
      renderer?.dispose()
      timer.dispose()
      cameraRef.current = null
      cubeRef.current = null
      gridRef.current = null
      axesHelperRef.current = null
      xyAxesGizmoRef.current = null
      floorRef.current = null

      runtimeRef.current = createRuntimeState()
      setRuntimeReady(false)
      setPlayback('stopped')
    }

    void (async () => {
      try {
        await ensureEffekseerRuntimeLoaded()
        effekseerApi = window.effekseer
        if (!effekseerApi) {
          throw new Error(`Effekseer runtime scripts are not available from ${EFFEKSEER_RUNTIME_BASE}`)
        }

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
        renderer.outputColorSpace = runtimeConfigApplied.outputColorSpace === 'linear'
          ? THREE.LinearSRGBColorSpace
          : THREE.SRGBColorSpace
        if (cancelled) {
          cleanup()
          return
        }

        if (!effekseerRuntimeInitialized) {
          effekseerApi.setWebGPUDevice(device)
          await effekseerApi.initRuntime(EFFEKSEER_RUNTIME_WASM_URL)
          ;(effekseerApi as unknown as { setLogEnabled?: (flag: boolean) => void }).setLogEnabled?.(true)
          effekseerRuntimeInitialized = true
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

        // Samples are loaded on-demand via loadEffect(path/bytes). Do not pre-register,
        // because failed managed preloads can poison the internal effect cache.
        resize()
        setRuntimeReady(true)
        setConverterStatus('Runtime ready. Choose a built-in sample or load a converted package.')
        window.addEventListener('resize', resize)

        frame = window.requestAnimationFrame(render)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        cleanup()
      }
    })()

    return cleanup
  }, [clearConvertedRegistration, playRegisteredEffect, releaseBuiltInEffects, runtimeConfigApplied])

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
      return
    }

    if (playback === 'paused' && isHandleAlive(handle) && handle?.setPaused) {
      handle.setPaused(false)
      setPlayback('playing')
      return
    }

    if (runtime.activeEffectId === 'converted-preview' && runtime.directEffect) {
      playDirectEffect(runtime.directEffect, 'converted-preview', convertedPackage?.outputName ?? 'converted preview')
      return
    }

    void playRegisteredEffect(runtime.activeEffectId)
  }, [convertedPackage?.outputName, playback, playDirectEffect, playRegisteredEffect])

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
  }, [])

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
  }, [])

  const promptDependencyFolderViaInput = useCallback((source: File): Promise<DependencyImportFile[]> => {
    const input = depsInputRef.current
    if (!input) {
      return Promise.resolve([])
    }

    input.value = ''

    return new Promise((resolve) => {
      let settled = false

      const finish = (entries: DependencyImportFile[]) => {
        if (settled) return
        settled = true
        window.removeEventListener('focus', handleFocus)
        input.removeEventListener('change', handleChange)
        resolve(filterDependencyImportFiles(source, entries))
      }

      const handleChange = () => {
        const entries = Array.from(input.files ?? []).map((file) => ({
          file,
          relativePath: normalizeDependencyRelativePath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name),
        }))
        finish(entries)
      }

      const handleFocus = () => {
        window.setTimeout(() => finish([]), 0)
      }

      input.addEventListener('change', handleChange)
      window.addEventListener('focus', handleFocus, { once: true })
      input.click()
    })
  }, [])

  const promptDependencyFolder = useCallback(async (source: File, token: number) => {
    let nextDependencyFiles: DependencyImportFile[] = []

    try {
      const pickerWindow = window as DirectoryPickerWindow
      if (typeof pickerWindow.showDirectoryPicker === 'function') {
        const directory = await pickerWindow.showDirectoryPicker({
          mode: 'read',
          id: SOURCE_PICKER_ID,
          startIn: sourceHandleRef.current ?? 'documents',
        })
        nextDependencyFiles = filterDependencyImportFiles(source, await collectDependencyFilesFromDirectory(directory))
      } else {
        nextDependencyFiles = await promptDependencyFolderViaInput(source)
      }
    } catch (cause) {
      const errorName = cause instanceof DOMException ? cause.name : ''
      if (errorName !== 'AbortError') {
        throw cause
      }
      nextDependencyFiles = []
    }

    if (dependencyPromptTokenRef.current !== token) {
      return
    }

    setDependencyFiles(nextDependencyFiles)
    setConverterStatus(
      nextDependencyFiles.length > 0
        ? `Source: ${source.name} + ${nextDependencyFiles.length} dependency files`
        : `Source: ${source.name}`
    )
    setPendingAutoConvert(true)
  }, [promptDependencyFolderViaInput])

  const beginSourceImport = useCallback(async (nextFile: File | null, sourceHandle: FileSystemFileHandleLike | null = null) => {
    sourceHandleRef.current = sourceHandle
    if (nextFile && !isSupportedImportSource(nextFile.name)) {
      dependencyPromptTokenRef.current += 1
      setSourceFile(null)
      setConvertedPackage(null)
      setDependencyFiles([])
      setPendingAutoConvert(false)
      setLoadingMessage('')
      setError('Only .efkefc, .efkpkg, .efkwg, or .efkwgpk sources are supported.')
      setConverterStatus('Choose .efkefc, .efkpkg, .efkwg, or .efkwgpk')
      if (sourceInputRef.current) {
        sourceInputRef.current.value = ''
      }
      return
    }

    if (
      nextFile &&
      !isDirectViewerSource(nextFile.name) &&
      !authUser &&
      !usesLocalStartEffectConversion()
    ) {
      openSignInPrompt('You must sign in with Google before importing effects.')
      dependencyPromptTokenRef.current += 1
      setSourceFile(null)
      setConvertedPackage(null)
      setDependencyFiles([])
      setPendingAutoConvert(false)
      setLoadingMessage('')
      setError('')
      setConverterStatus('Sign in to import and store locked artifacts.')
      if (sourceInputRef.current) {
        sourceInputRef.current.value = ''
      }
      return
    }

    const nextToken = dependencyPromptTokenRef.current + 1
    dependencyPromptTokenRef.current = nextToken
    setSourceFile(nextFile)
    setConvertedPackage(null)
    setDependencyFiles([])
    setPendingAutoConvert(false)
    setConverterStatus(nextFile ? `Source: ${nextFile.name}` : 'Choose a source effect first.')
    setLoadingMessage('')
    setError('')

    if (!nextFile) {
      return
    }

    if (!requiresDependencyFolderPrompt(nextFile.name)) {
      setPendingAutoConvert(true)
      return
    }

    setConverterStatus(`Source: ${nextFile.name}. Select a dependency folder or cancel to continue.`)
    void promptDependencyFolder(nextFile, nextToken).catch((cause) => {
      if (dependencyPromptTokenRef.current !== nextToken) {
        return
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      setConverterStatus(message)
      setPendingAutoConvert(true)
    })
  }, [authUser, openSignInPrompt, promptDependencyFolder])

  const openSourcePicker = useCallback(async () => {
    const pickerWindow = window as DirectoryPickerWindow
    if (typeof pickerWindow.showOpenFilePicker === 'function') {
      try {
        const handles = await pickerWindow.showOpenFilePicker({
          id: SOURCE_PICKER_ID,
          multiple: false,
          excludeAcceptAllOption: false,
          types: [
            {
              description: 'Effekseer effects',
              accept: {
                'application/octet-stream': ['.efkefc', '.efkpkg', '.efkwg', '.efkwgpk'],
              },
            },
          ],
        })
        const handle = handles[0] ?? null
        if (!handle) return
        const file = await handle.getFile()
        await beginSourceImport(file, handle)
        return
      } catch (cause) {
        const errorName = cause instanceof DOMException ? cause.name : ''
        if (errorName === 'AbortError') {
          return
        }
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        setConverterStatus(message)
        return
      }
    }

    sourceInputRef.current?.click()
  }, [beginSourceImport])

  const handleSourceChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null
    if (sourceInputRef.current) {
      sourceInputRef.current.value = ''
    }
    void beginSourceImport(nextFile, null)
  }, [beginSourceImport])

  const runConvert = useCallback(async () => {
    if (!sourceFile) {
      setConverterStatus('Choose a source effect first.')
      return
    }
    if (converting) return

    setConverting(true)
    setLoadingMessage(`Loading package: ${sourceFile.name}`)
    setError('')
    setConverterStatus(`Loading ${sourceFile.name}...`)

    try {
      if (!isSupportedImportSource(sourceFile.name)) {
        throw new Error('Only .efkefc, .efkpkg, .efkwg, or .efkwgpk sources are supported.')
      }

      const directViewerSource = isDirectViewerSource(sourceFile.name)

      if (!directViewerSource && !authUser && !usesLocalStartEffectConversion()) {
        openSignInPrompt('You must sign in with Google before importing effects.')
        setConverterStatus('Sign in to import and store locked artifacts.')
        return
      }

      if (!directViewerSource && !usesLocalStartEffectConversion() && accountUser && !canAccountStartPreviewConversion(accountUser)) {
        setError('')
        setLoadingMessage('')
        setConverterStatus(PREVIEW_CONVERSION_BLOCKED_MESSAGE)
        setShowCreditPackModal(true)
        return
      }

      setLoadingMessage(`Reading source: ${sourceFile.name}`)
      const sourceBytes = new Uint8Array(await sourceFile.arrayBuffer())

      if (directViewerSource) {
        const sourceSha256 = await sha256Hex(sourceBytes)
        const result: LocalConvertedPackage = {
          artifactId: null,
          alreadyExisted: false,
          bytes: sourceBytes,
          outputName: sourceFile.name,
          mainEffectPath: sourceFile.name,
          bytesLength: sourceBytes.byteLength,
          sha256: sourceSha256,
          status: 'completed',
          artifactSha256: sourceSha256,
          artifactBytesLength: sourceBytes.byteLength,
          sourceKind: 'direct',
          dependencyFiles: sourceFile.name.toLowerCase().endsWith('.efkwg') ? dependencyFiles : [],
        }

        setConverterStatus(`Loaded ${result.outputName} ${(result.artifactBytesLength / 1024).toFixed(1)} KB`)
        setConvertedPackage(result)
        setConvertedList((prev) => {
          const exists = prev.some((item) => item.outputName === result.outputName)
          if (exists) return prev.map((item) => item.outputName === result.outputName ? result : item)
          return [...prev, result]
        })

        await loadConvertedPreview(result)
        return
      }

      const extraFiles = []
      if (dependencyFiles.length > 0) setLoadingMessage(`Reading dependencies: ${dependencyFiles.length}`)
      if (!sourceFile.name.toLowerCase().endsWith('.efkefc')) {
        for (const dependencyFile of dependencyFiles) {
          extraFiles.push({
            name: dependencyFile.file.name,
            relativePath: dependencyFile.relativePath,
            bytes: new Uint8Array(await dependencyFile.file.arrayBuffer()),
          })
        }
      }

      setLoadingMessage(`Converting source: ${sourceFile.name}`)
      const conversion = await startEffectConversion({
        sourceName: sourceFile.name,
        sourceBytes,
        extraFiles,
      })

      const result: LocalConvertedPackage = {
        ...conversion,
        bytes: conversion.bytes,
        artifactId: conversion.artifactId ?? null,
        artifactSha256: conversion.sha256,
        artifactBytesLength: conversion.bytesLength,
        sourceKind: 'converted',
        dependencyFiles,
      }

      setConverterStatus(
        result.artifactId
          ? `${result.outputName} ready ${(result.artifactBytesLength / 1024).toFixed(1)} KB`
          : `${result.outputName} preview ready ${(result.artifactBytesLength / 1024).toFixed(1)} KB`
      )
      upsertLocalConvertedPackage(result)

      try {
        await loadConvertedPreview(result)
      } catch (previewError) {
        const message = previewError instanceof Error ? previewError.message : String(previewError)
        setError(message)
        setConverterStatus(message)
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (cause instanceof Error && cause.stack) {
        console.error(cause.stack)
      }
      setConvertedPackage(null)
      if (cause instanceof FunctionApiError && cause.code === 'preview_conversion_limit_reached') {
        setError('')
        setConverterStatus(PREVIEW_CONVERSION_BLOCKED_MESSAGE)
        setShowCreditPackModal(true)
      } else {
        setError(message)
        setConverterStatus(message)
      }
    } finally {
      setLoadingMessage('')
      setConverting(false)
    }
  }, [accountUser, authUser, converting, dependencyFiles, loadConvertedPreview, openSignInPrompt, sourceFile, upsertLocalConvertedPackage])

  useEffect(() => {
    if (!pendingAutoConvert) return
    if (!sourceFile) {
      setPendingAutoConvert(false)
      return
    }
    if (converting) return
    setPendingAutoConvert(false)
    void runConvert()
  }, [converting, pendingAutoConvert, runConvert, sourceFile])

  const downloadConverted = useCallback(() => {
    if (!convertedPackage) return
    if (convertedPackage.sourceKind === 'direct') {
      if (!(convertedPackage.bytes instanceof Uint8Array)) {
        setError(`Local bytes are unavailable for ${convertedPackage.outputName}.`)
        return
      }
      void downloadLocalArtifact(convertedPackage.bytes, convertedPackage.outputName)
      return
    }
    const accountArtifact = convertedPackage.artifactId
      ? accountArtifacts.find((artifact) => artifact.artifactId === convertedPackage.artifactId) ?? null
      : convertedPackage.artifactSha256
        ? accountArtifacts.find((artifact) => artifact.sha256 === convertedPackage.artifactSha256) ?? null
        : null
    if (accountArtifact?.unlockStatus === 'unlocked') {
      void downloadUnlockedAccountArtifact(accountArtifact).catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        setConverterStatus(message)
      })
      return
    }
    setShowUnlockModal({
      kind: 'session',
      item: convertedPackage,
      accountArtifact,
    })
  }, [accountArtifacts, convertedPackage, downloadLocalArtifact, downloadUnlockedAccountArtifact])

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

  const credits = accountUser?.availableCredits ?? 0
  const currentSessionEntries = convertedList.filter((item) => !accountArtifacts.some((artifact) => (
    (!!item.artifactId && artifact.artifactId === item.artifactId) ||
    (!!item.artifactSha256 && artifact.sha256 === item.artifactSha256)
  )))
  const purchasedAccountArtifacts = accountArtifacts.filter((artifact) => artifact.unlockStatus === 'unlocked')
  const lockedAccountArtifacts = accountArtifacts.filter((artifact) => artifact.unlockStatus !== 'unlocked')
  const libraryEntryCount = accountArtifacts.length + currentSessionEntries.length
  const pendingRuntimeChanges = pendingRuntimeConfig
    ? describeRuntimeConfigChanges(runtimeConfigApplied, pendingRuntimeConfig)
    : []
  const renderSessionLibraryItem = (item: LocalConvertedPackage) => {
    const active = activeEffectId === 'converted-preview' && convertedPackage?.outputName === item.outputName
    const matchingAccountArtifact = item.artifactId
      ? accountArtifacts.find((artifact) => artifact.artifactId === item.artifactId) ?? null
      : item.artifactSha256
        ? accountArtifacts.find((artifact) => artifact.sha256 === item.artifactSha256) ?? null
        : null
    const displayName = item.outputName
    return (
      <div
        key={item.outputName}
        className={`converted-item ${active ? 'active' : ''}`}
        onClick={() => {
          setConvertedPackage(item)
          if (item.bytes) {
            void loadConvertedPreview(item)
            return
          }
          setConverterStatus(`Preview locked: ${item.outputName}`)
        }}
      >
        <span className="converted-name" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {displayName.includes('.') ? displayName.substring(0, displayName.indexOf('.')) : displayName}
          <span className="ext-label">{displayName.includes('.') ? displayName.substring(displayName.indexOf('.')) : ''}</span>
        </span>
        <button
          type="button"
          className={`converted-action ${item.sourceKind === 'direct' || matchingAccountArtifact?.unlockStatus === 'unlocked' ? 'unlocked' : 'locked'}`}
          title={
            item.sourceKind === 'direct'
              ? `Download ${item.outputName}`
              : matchingAccountArtifact?.unlockStatus === 'unlocked'
              ? `Download ${item.outputName}`
              : `Unlock ${item.outputName}`
          }
          onClick={(e) => {
            e.stopPropagation()
            if (item.sourceKind === 'direct') {
              if (!(item.bytes instanceof Uint8Array)) {
                setError(`Local bytes are unavailable for ${item.outputName}.`)
                return
              }
              void downloadLocalArtifact(item.bytes, item.outputName)
              return
            }
            if (matchingAccountArtifact?.unlockStatus === 'unlocked') {
              void downloadUnlockedAccountArtifact(matchingAccountArtifact).catch((cause: unknown) => {
                const message = cause instanceof Error ? cause.message : String(cause)
                setError(message)
                setConverterStatus(message)
              })
              return
            }
            setShowUnlockModal({
              kind: 'session',
              item,
              accountArtifact: matchingAccountArtifact,
            })
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
            removeConvertedPackageByOutputName(item.outputName)
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </div>
    )
  }

  const renderAccountLibraryItem = (artifact: AccountArtifactRecord) => {
    const localMatch = convertedList.find((item) => (
      (!!item.artifactId && item.artifactId === artifact.artifactId) ||
      (!!item.artifactSha256 && item.artifactSha256 === artifact.sha256)
    )) ?? null
    const active = !!localMatch && activeEffectId === 'converted-preview' && convertedPackage?.outputName === localMatch.outputName
    const unlocked = artifact.unlockStatus === 'unlocked'

    return (
      <div
        key={artifact.artifactId}
        className={`converted-item ${active ? 'active' : ''} ${unlocked ? 'library-item-unlocked' : ''}`}
        onClick={() => {
          void loadAccountArtifactPreview(artifact).catch((cause: unknown) => {
            const message = cause instanceof Error ? cause.message : String(cause)
            setError(message)
            setConverterStatus(message)
          })
        }}
      >
        <span className={`converted-name ${unlocked ? 'library-item-name-unlocked' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {unlocked ? (
            <span className="library-item-effect-icon" aria-hidden="true">
              <Sparkles size={12} strokeWidth={2} fill="currentColor" />
            </span>
          ) : null}
          {artifact.displayName.includes('.') ? artifact.displayName.substring(0, artifact.displayName.indexOf('.')) : artifact.displayName}
          <span className="ext-label">{artifact.displayName.includes('.') ? artifact.displayName.substring(artifact.displayName.indexOf('.')) : ''}</span>
        </span>
        <button
          type="button"
          className={`converted-action ${unlocked ? 'unlocked' : 'locked'}`}
          title={unlocked ? `Download ${artifact.outputName}` : `Unlock ${artifact.outputName}`}
          onClick={(event) => {
            event.stopPropagation()
            if (unlocked) {
              void downloadUnlockedAccountArtifact(artifact).catch((cause: unknown) => {
                const message = cause instanceof Error ? cause.message : String(cause)
                setError(message)
                setConverterStatus(message)
              })
              return
            }
            setShowUnlockModal({
              kind: 'account',
              artifact,
            })
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1v9m0 0L5 7m3 3l3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
        <button
          type="button"
          className="converted-action converted-remove"
          title={`Delete ${artifact.outputName} from account library`}
          onClick={(event) => {
            event.stopPropagation()
            setDeleteError('')
            setShowDeleteArtifactModal({ artifact })
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </div>
    )
  }
  const unlockModalName = showUnlockModal
    ? showUnlockModal.kind === 'session'
      ? showUnlockModal.item.outputName
      : showUnlockModal.artifact.outputName
    : ''
  const unlockModalAlreadyUnlocked = !!showUnlockModal && (
    showUnlockModal.kind === 'account'
      ? showUnlockModal.artifact.unlockStatus === 'unlocked'
      : showUnlockModal.accountArtifact?.unlockStatus === 'unlocked'
  )
  const unlockModalRequiresSignIn = !!showUnlockModal && !authUser
  const unlockModalRequiresCredits = !!showUnlockModal && !unlockModalRequiresSignIn && !unlockModalAlreadyUnlocked && (
    credits < 1
  )
  const unlockPrimaryLabel = unlockModalRequiresSignIn
    ? 'Sign In with Google'
    : unlockModalAlreadyUnlocked
      ? 'Download'
      : 'Unlock & Download'
  const renderCreditPackOptions = (target: UnlockTarget | null) => (
    <div className="credit-pack-grid">
      {CREDIT_PACKS.map((pack) => (
        <div
          key={pack.id}
          className={`credit-pack-card ${pack.featured ? 'featured' : ''}`}
        >
          <div className="credit-pack-head">
            <div>
              <div className="credit-pack-label">{pack.label}</div>
              <div className="credit-pack-amount">{pack.credits} Credits</div>
            </div>
            {pack.featured ? <span className="credit-pack-badge">Best Value</span> : null}
          </div>
          <div className="credit-pack-price">${pack.priceUsd}</div>
          <button
            type="button"
            className="btn-primary credit-pack-btn"
            disabled={checkoutPending}
            onClick={() => void handleCreditPackPurchase(pack.id, target)}
          >
            {checkoutPending ? 'Redirecting...' : `Buy ${pack.credits} Credits`}
          </button>
        </div>
      ))}
    </div>
  )
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
          <div className="credit-pill" title="Available Credits">
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
                {accountUser?.photoURL || authUser?.photoURL ? (
                  <img
                    src={accountUser?.photoURL || authUser?.photoURL || ''}
                    alt="Profile"
                  />
                ) : (
                  <CircleUserRound size={24} strokeWidth={1.8} />
                )}
              </div>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
            </button>
            {showProfileMenu && (
              <div className="profile-menu">
                <div className="menu-item" onClick={() => setShowProfileMenu(false)}>
                  {accountUser?.displayName || authUser?.displayName || 'Guest'}
                </div>
                <div className="menu-item" onClick={() => void handleOpenCreditPackModal()}>
                  Buy Credits
                </div>
                <div className="menu-sep"></div>
                {authUser ? (
                  <div className="menu-item" onClick={() => void handleSignOut()}>Sign Out</div>
                ) : (
                  <div className="menu-item" onClick={() => void handleSignIn()}>
                    Sign In with Google
                  </div>
                )}
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
            <button type="button" className="menu-action" onClick={() => void openSourcePicker()}>
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
            <button type="button" className="menu-action" onClick={() => setViewMode('3d')}>
              <MenuCheckLabel label="3D View" checked={viewMode === '3d'} />
            </button>
            <button type="button" className="menu-action" onClick={() => setViewMode('xy')}>
              <MenuCheckLabel label="2D View" checked={viewMode === 'xy'} />
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
            <div className="menu-sep" />
            <button type="button" className="menu-action" onClick={() => queueRuntimeConfigReload({ ...runtimeConfigDraft, outputColorSpace: 'srgb' })}>
              <MenuCheckLabel label="sRGB Color Space" checked={runtimeConfigDraft.outputColorSpace === 'srgb'} />
            </button>
            <button type="button" className="menu-action" onClick={() => queueRuntimeConfigReload({ ...runtimeConfigDraft, outputColorSpace: 'linear' })}>
              <MenuCheckLabel label="Linear Color Space" checked={runtimeConfigDraft.outputColorSpace === 'linear'} />
            </button>
            <div className="menu-sep" />
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
        accept=".efkefc,.efkpkg,.efkwg,.efkwgpk"
        onChange={handleSourceChange}
      />
      <input
        ref={depsInputRef}
        className="hidden-input"
        type="file"
        multiple
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
      />

      <div className="app-content">
        <div className="viewport">
          <canvas ref={canvasRef} className="render-canvas" />

          {(converting || !!loadingMessage) ? (
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
                    {convertedPackage.outputName.includes('.') ? convertedPackage.outputName.substring(0, convertedPackage.outputName.indexOf('.')) : convertedPackage.outputName}
                    <span className="ext-label">{convertedPackage.outputName.includes('.') ? convertedPackage.outputName.substring(convertedPackage.outputName.indexOf('.')) : ''}</span>
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
                  <div className="library-panel-subtitle">Account artifacts and current-session previews.</div>
                </div>
              </div>
              <div className="library-panel-count">{libraryEntryCount}</div>
            </div>
            {libraryEntryCount === 0 ? (
              <div className="library-empty-state">
                You do not have any library effects yet.
              </div>
            ) : (
              <div className="converted-list">
                {purchasedAccountArtifacts.length > 0 || lockedAccountArtifacts.length > 0 ? (
                  <>
                    <div className="library-section-label">Account Library</div>
                    {purchasedAccountArtifacts.map((artifact) => renderAccountLibraryItem(artifact))}
                    {lockedAccountArtifacts.map((artifact) => renderAccountLibraryItem(artifact))}
                  </>
                ) : null}
                {currentSessionEntries.length > 0 ? (
                  <>
                    <div className="library-section-label">Current Session</div>
                    {currentSessionEntries.map((item) => renderSessionLibraryItem(item))}
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

      {/* Unlock Confirmation Modal */}
      {showUnlockModal && (
        <div className="modal-overlay" onClick={() => setShowUnlockModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Unlock Premium Download?</h2>
              <button className="modal-close" onClick={() => setShowUnlockModal(null)}>×</button>
            </div>
            <div className="modal-body">
              <p>
                {unlockModalAlreadyUnlocked
                  ? <>Download your unlocked copy of <strong>{unlockModalName}</strong>.</>
                  : <>Unlock the permanent account download for <strong>{unlockModalName}</strong>.</>}
              </p>
              
              <div className="modal-cost-box">
                <span className="cost-label">Cost:</span>
                <span className="cost-value" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="rgba(218,165,32,0.2)"/>
                    <path d="M8 4V12M6 6H10M6 10H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  {unlockModalAlreadyUnlocked ? '0' : '1'}
                </span>
              </div>
              
              <div className="modal-balance">
                You have <strong>{credits}</strong> credits remaining.
              </div>

              {unlockModalRequiresSignIn ? (
                <div className="modal-error">Sign in with Google to continue with credit-based unlocks.</div>
              ) : null}
              {unlockModalRequiresCredits ? (
                <>
                  <div className="modal-error">You need at least 1 credit to unlock this download.</div>
                  {renderCreditPackOptions(showUnlockModal)}
                </>
              ) : null}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowUnlockModal(null)}>Cancel</button>
              {!unlockModalRequiresCredits ? (
                <button
                  className="btn-primary"
                  disabled={checkoutPending}
                  onClick={() => void handleUnlockDownload(showUnlockModal)}
                >
                  {checkoutPending ? 'Redirecting...' : unlockPrimaryLabel}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {showCreditPackModal && (
        <div className="modal-overlay" onClick={() => setShowCreditPackModal(false)}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Buy Credits</h2>
              <button className="modal-close" onClick={() => setShowCreditPackModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <p>Buy credits once and spend them whenever you want. Unlocks remain permanent.</p>
              <p>To continue previewing converted effects, purchase a credit pack.</p>
              <div className="modal-balance">
                You currently have <strong>{credits}</strong> credits available.
              </div>
              {renderCreditPackOptions(null)}
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowCreditPackModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {showSignInPromptModal && (
        <div className="modal-overlay" onClick={() => {
          if (signInPending) return
          setShowSignInPromptModal(false)
        }}>
          <div className="modal-content sign-in-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Sign In Required</h2>
              <button
                className="modal-close"
                onClick={() => {
                  if (signInPending) return
                  setShowSignInPromptModal(false)
                }}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>{signInPromptMessage}</p>
              <p className="sign-in-modal-note">Use your Google account to continue.</p>
            </div>
            <div className="modal-footer sign-in-modal-footer">
              <button
                type="button"
                className="google-signin-btn"
                disabled={signInPending}
                onClick={() => void handleGooglePromptSignIn()}
              >
                <span className="google-signin-icon" aria-hidden="true">
                  <svg viewBox="0 0 18 18" width="18" height="18">
                    <path fill="#EA4335" d="M9 7.2v3.6h5c-.22 1.16-.9 2.14-1.94 2.8l2.9 2.25c1.69-1.56 2.67-3.86 2.67-6.59 0-.61-.05-1.2-.16-1.77H9z"/>
                    <path fill="#34A853" d="M9 17.5c2.43 0 4.47-.8 5.96-2.19l-2.9-2.25c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.95v2.33A9 9 0 0 0 9 17.5z"/>
                    <path fill="#4A90E2" d="M3.95 10.2A5.41 5.41 0 0 1 3.67 9c0-.41.1-.81.28-1.2V5.47H.95A9 9 0 0 0 0 9c0 1.45.35 2.82.95 4.03l3-2.33z"/>
                    <path fill="#FBBC05" d="M9 4.08c1.32 0 2.5.45 3.43 1.33l2.57-2.57C13.46 1.4 11.43.5 9 .5A9 9 0 0 0 .95 5.47l3 2.33C4.66 5.67 6.65 4.08 9 4.08z"/>
                  </svg>
                </span>
                <span>{signInPending ? 'Opening Google...' : 'Continue with Google'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteArtifactModal && (
        <div className="modal-overlay" onClick={() => {
          if (deletePending) return
          setShowDeleteArtifactModal(null)
          setDeleteError('')
        }}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Delete Library Effect?</h2>
              <button
                className="modal-close"
                onClick={() => {
                  if (deletePending) return
                  setShowDeleteArtifactModal(null)
                  setDeleteError('')
                }}
              >
                x
              </button>
            </div>
            <div className="modal-body">
              <p>
                Delete <strong>{showDeleteArtifactModal.artifact.outputName}</strong> from your account library?
              </p>
              <p>This removes the stored premium download from your account library. This action cannot be undone.</p>
              {deleteError ? <div className="modal-error">{deleteError}</div> : null}
            </div>
            <div className="modal-footer">
              <button
                className="btn-secondary"
                onClick={() => {
                  if (deletePending) return
                  setShowDeleteArtifactModal(null)
                  setDeleteError('')
                }}
              >
                Cancel
              </button>
              <button
                className="btn-danger"
                disabled={deletePending}
                onClick={() => void handleConfirmDeleteArtifact()}
              >
                {deletePending ? 'Deleting...' : 'Delete Effect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
