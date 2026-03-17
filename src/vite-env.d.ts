/// <reference types="vite/client" />

declare module '*.efkwgpk?url' {
  const url: string
  export default url
}

type GPUTextureFormat = string

type GPUColor = {
  r: number
  g: number
  b: number
  a: number
}

interface GPUTextureView {}

interface GPUTexture {
  createView(): GPUTextureView
}

interface GPURenderPassEncoder {
  end(): void
}

interface GPUCommandBuffer {}

interface GPUCommandEncoder {
  beginRenderPass(descriptor: unknown): GPURenderPassEncoder
  finish(): GPUCommandBuffer
}

interface GPUQueue {
  submit(commandBuffers: GPUCommandBuffer[]): void
}

interface GPUDevice {
  queue: GPUQueue
  createCommandEncoder(descriptor?: { label?: string }): GPUCommandEncoder
}

interface GPUAdapterInfo {
  description?: string
}

interface GPUAdapter {
  info?: GPUAdapterInfo
  requestDevice(): Promise<GPUDevice>
}

interface GPUCanvasConfiguration {
  device: GPUDevice
  format: GPUTextureFormat
  alphaMode?: 'opaque' | 'premultiplied'
}

interface GPUCanvasContext {
  configure(configuration: GPUCanvasConfiguration): void
  getCurrentTexture(): GPUTexture
}

interface NavigatorGPU {
  requestAdapter(): Promise<GPUAdapter | null>
  getPreferredCanvasFormat(): GPUTextureFormat
}

interface Navigator {
  gpu: NavigatorGPU
}
