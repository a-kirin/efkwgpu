import 'three/webgpu'
import type { Camera, RenderTarget } from 'three'

declare module 'three/webgpu' {
  export interface ExternalRenderPassHookInfo {
    renderer: WebGPURenderer
    renderPassEncoder: GPURenderPassEncoder
    commandEncoder: GPUCommandEncoder
    colorFormat: GPUTextureFormat
    depthStencilFormat: GPUTextureFormat | null
    sampleCount: number
    isDefaultCanvasTarget: boolean
    renderTarget: RenderTarget | null
    camera: Camera | null
    colorAttachmentView: GPUTextureView
    resolveTargetView: GPUTextureView | null
    depthStencilAttachmentView: GPUTextureView | null
    sampleableColorTextureView: GPUTextureView | null
    sampleableDepthTextureView: GPUTextureView | null
  }

  export type ExternalRenderPassHook = (info: ExternalRenderPassHookInfo) => void

  export interface WebGPURenderer {
    setExternalRenderPassHook(callback: ExternalRenderPassHook | null): this
    getExternalRenderPassHook(): ExternalRenderPassHook | null
  }
}
