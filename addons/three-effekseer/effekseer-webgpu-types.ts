export type ManagedEffectInput = string | {
  path: string
  scale?: number
  enabled?: boolean
}

export type EffekseerContextSettings = {
  instanceMaxCount?: number
  squareMaxCount?: number
  linearColorSpace?: boolean
  compositeWithBackground?: boolean
  effects?: Record<string, ManagedEffectInput>
}

export type EffekseerExternalRenderPassState = {
  colorFormat: GPUTextureFormat
  depthFormat?: GPUTextureFormat | null
  sampleCount?: number
  backgroundTextureView?: GPUTextureView | null
  depthTextureView?: GPUTextureView | null
  // Deprecated compatibility aliases. Prefer backgroundTextureView/depthTextureView.
  importBackgroundTextureView?: GPUTextureView | null
  importDepthTextureView?: GPUTextureView | null
}

export type EffekseerHandle = {
  stop(): void
  setLocation?(x: number, y: number, z: number): void
  setScale?(x: number, y: number, z: number): void
  setRotation?(x: number, y: number, z: number): void
  setMatrix?(matrixArray: ArrayLike<number>): void
}

export type EffekseerContext = {
  init(target: HTMLCanvasElement | string, settings?: EffekseerContextSettings): boolean
  initExternal(settings?: EffekseerContextSettings): boolean
  registerEffects(effects: Record<string, ManagedEffectInput>): void
  preloadEffects(ids?: string[] | string): Promise<Map<string, unknown | null>>
  whenEffectsReady(ids?: string[] | string): Promise<Map<string, unknown | null>>
  playEffect(id: string, x?: number, y?: number, z?: number): EffekseerHandle | null
  update(deltaFrames?: number): void
  draw(): void
  drawExternal(
    renderPassEncoder: GPURenderPassEncoder,
    renderPassState?: EffekseerExternalRenderPassState,
    mode?: 'all' | 'back' | 'front'
  ): void
  stopAll(): void
  setCompositeMode(enabled: boolean): void
  setProjectionPerspective(fov: number, aspect: number, near: number, far: number): void
  setCameraLookAt(
    positionX: number,
    positionY: number,
    positionZ: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    upvecX: number,
    upvecY: number,
    upvecZ: number
  ): void
  setProjectionMatrix(matrixArray: ArrayLike<number>): void
  setCameraMatrix(matrixArray: ArrayLike<number>): void
}

export type EffekseerApi = {
  setWebGPUDevice(device: GPUDevice): void
  initRuntime(path: string): Promise<void>
  createContext(): EffekseerContext | null
  releaseContext(context: EffekseerContext | null): void
}

declare global {
  interface Window {
    effekseer?: EffekseerApi
  }
}
