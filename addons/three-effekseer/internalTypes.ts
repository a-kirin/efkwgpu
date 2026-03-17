import type { DepthTexture, RenderTarget, Texture } from 'three'
import type { ExternalRenderPassHookInfo } from 'three/webgpu'
import type { EffekseerContext, EffekseerExternalRenderPassState } from './effekseer-webgpu-types'

export interface ThreeEffekseerPassNodeLike {
  renderTarget: RenderTarget
  getTextureNode(name: 'output' | 'depth'): unknown
}

export interface ThreeEffekseerScenePassResources {
  scenePass: ThreeEffekseerPassNodeLike | null
  renderTarget: RenderTarget | null
  colorTexture: Texture | null
  depthTexture: DepthTexture | null
  nativeColorTexture: GPUTexture | null
  nativeColorTextureView: GPUTextureView | null
  nativeDepthTexture: GPUTexture | null
  nativeDepthTextureView: GPUTextureView | null
}

export interface ThreeEffekseerFinalPassState {
  backgroundTextureView: GPUTextureView | null
  depthTextureView: GPUTextureView | null
  effekseerPassState: EffekseerExternalRenderPassState
}

export interface ThreeEffekseerPresenterRenderInput {
  scenePassResources: ThreeEffekseerScenePassResources
  effekseer: EffekseerContext
}

export type ResolveCompositePassState = (
  input: ThreeEffekseerPresenterRenderInput,
  info: ExternalRenderPassHookInfo
) => ThreeEffekseerFinalPassState | null

export interface ThreeEffekseerComposePassPresenter {
  render(input: ThreeEffekseerPresenterRenderInput): void
  resize(width: number, height: number, pixelRatio: number): void
  dispose(): void
}

export interface ThreeEffekseerFinalPassPresenter {
  render(texture: Texture): void
  resize(width: number, height: number, pixelRatio: number): void
  dispose(): void
}
