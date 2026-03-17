import type { Camera, Scene } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type { EffekseerContext } from './effekseer-webgpu-types'

export type ThreeEffekseerPassMode = 'basic' | 'composite'

export interface ThreeEffekseerPassInit {
  renderer: WebGPURenderer
  scene: Scene
  camera: Camera
  effekseer: EffekseerContext
}

export interface ThreeEffekseerPassOptions {
  mode?: ThreeEffekseerPassMode
  idleOptimization?: boolean
}

export interface ThreeEffekseerPassCapabilities {
  mode: ThreeEffekseerPassMode
  supportsDistortion: boolean
  supportsDepthOcclusion: boolean
  supportsSoftParticles: boolean
  supportsLOD: boolean
  supportsCollisions: boolean
}

export interface ThreeEffekseerPass {
  getCapabilities(): ThreeEffekseerPassCapabilities
  resize(width: number, height: number, pixelRatio: number): void
  render(deltaFrames: number): void
  dispose(): void
}
