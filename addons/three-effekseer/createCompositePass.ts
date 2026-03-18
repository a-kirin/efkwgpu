import * as THREE from 'three/webgpu'
import type { ExternalRenderPassHookInfo } from 'three/webgpu'
import createEffekseerActivityTracker from './createEffekseerActivityTracker'
import { syncEffekseerCamera, updateCameraProjection } from './common'
import createCompositePassPresenter from './createCompositePassPresenter'
import createFinalPassPresenter from './createFinalPassPresenter'
import type {
  ThreeEffekseerPass,
  ThreeEffekseerPassCapabilities,
  ThreeEffekseerPassInit,
  ThreeEffekseerPassOptions,
} from './types'
import type {
  ThreeEffekseerFinalPassState,
  ThreeEffekseerPassNodeLike,
  ThreeEffekseerScenePassResources,
} from './internalTypes'
import { getNativeGPUTexture } from './webgpuInternals'

type SceneCaptureTrigger = {
  render(): void
  resize(width: number, height: number, pixelRatio: number): void
  dispose(): void
}

type DepthCaptureTrigger = {
  render(): void
  resize(width: number, height: number, pixelRatio: number): void
  dispose(): void
}

function createTextureView(texture: GPUTexture | null): GPUTextureView | null {
  if (!texture) {
    return null
  }

  try {
    return texture.createView()
  } catch {
    return null
  }
}

function createTextureViewFromThreeTexture(
  renderer: THREE.WebGPURenderer,
  texture: THREE.Texture | null
): GPUTextureView | null {
  if (!texture) {
    return null
  }

  try {
    const nativeTexture = getNativeGPUTexture(renderer, texture)
    return createTextureView(nativeTexture)
  } catch {
    return null
  }
}

function createSceneCaptureTrigger(
  renderer: THREE.WebGPURenderer,
  scenePass: ThreeEffekseerPassNodeLike,
  samples: number
): SceneCaptureTrigger {
  const postProcessing = new THREE.PostProcessing(renderer)
  const triggerTarget = new THREE.RenderTarget(1, 1, {
    type: renderer.getOutputBufferType(),
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: false,
    samples,
  })

  triggerTarget.texture.name = 'ThreeEffekseer.captureTrigger'
  postProcessing.outputColorTransform = false
  postProcessing.outputNode = scenePass.getTextureNode('output') as THREE.Node

  return {
    render() {
      const previousRenderTarget = renderer.getRenderTarget()
      const previousActiveCubeFace = renderer.getActiveCubeFace()
      const previousActiveMipmapLevel = renderer.getActiveMipmapLevel()

      renderer.setRenderTarget(triggerTarget)

      try {
        postProcessing.render()
      } finally {
        renderer.setRenderTarget(
          previousRenderTarget,
          previousActiveCubeFace,
          previousActiveMipmapLevel
        )
      }
    },

    resize() {},

    dispose() {
      postProcessing.dispose()
      triggerTarget.dispose()
    },
  }
}

function createSoftParticleDepthCaptureTrigger(
  renderer: THREE.WebGPURenderer,
  scenePass: ThreeEffekseerPassNodeLike,
  renderTarget: THREE.RenderTarget
): DepthCaptureTrigger {
  const postProcessing = new THREE.PostProcessing(renderer)
  const depthTexture = scenePass.renderTarget.depthTexture!
  const depthNode = THREE.TSL.texture(
    depthTexture,
    THREE.TSL.screenUV.flipY()
  ) as THREE.Node & { oneMinus(): THREE.Node }

  postProcessing.outputColorTransform = false
  // Effekseer WebGPU shaders read soft-particle depth as `1.0 - depthTexture`.
  // Three's screen-space sampling path is Y-flipped under WebGPU, so sample the
  // scene-pass depth with `screenUV.flipY()` before storing the inverted value.
  const depthCopyNode = depthNode.oneMinus()
  postProcessing.outputNode = THREE.TSL.vec4(depthCopyNode, depthCopyNode, depthCopyNode, 1.0)

  return {
    render() {
      const previousRenderTarget = renderer.getRenderTarget()
      const previousActiveCubeFace = renderer.getActiveCubeFace()
      const previousActiveMipmapLevel = renderer.getActiveMipmapLevel()

      renderer.setRenderTarget(renderTarget)

      try {
        postProcessing.render()
      } finally {
        renderer.setRenderTarget(
          previousRenderTarget,
          previousActiveCubeFace,
          previousActiveMipmapLevel
        )
      }
    },

    resize() {},

    dispose() {
      postProcessing.dispose()
    },
  }
}

function syncScenePassResources(
  renderer: THREE.WebGPURenderer,
  scenePassResources: ThreeEffekseerScenePassResources
): void {
  const renderTarget = scenePassResources.scenePass?.renderTarget ?? null
  const colorTexture = renderTarget?.texture ?? null
  const depthTexture = renderTarget?.depthTexture ?? null

  scenePassResources.renderTarget = renderTarget
  scenePassResources.colorTexture = colorTexture
  scenePassResources.depthTexture = depthTexture
  scenePassResources.nativeColorTexture = colorTexture ? getNativeGPUTexture(renderer, colorTexture) : null
  scenePassResources.nativeColorTextureView = scenePassResources.nativeColorTexture?.createView() ?? null
  scenePassResources.nativeDepthTexture = depthTexture ? getNativeGPUTexture(renderer, depthTexture) : null
  scenePassResources.nativeDepthTextureView = null
}

function createFinalPassState(
  renderer: THREE.WebGPURenderer,
  scenePassResources: ThreeEffekseerScenePassResources,
  softParticleDepthTarget: THREE.RenderTarget | null,
  info: ExternalRenderPassHookInfo
): ThreeEffekseerFinalPassState | null {
  syncScenePassResources(renderer, scenePassResources)

  const backgroundTextureView = scenePassResources.nativeColorTextureView
  const depthTextureView = createTextureViewFromThreeTexture(
    renderer,
    softParticleDepthTarget?.texture ?? null
  )

  return {
    backgroundTextureView,
    depthTextureView,
    effekseerPassState: {
      colorFormat: info.colorFormat,
      depthFormat: info.depthStencilFormat,
      sampleCount: info.sampleCount,
      ...(backgroundTextureView ? { backgroundTextureView } : {}),
      ...(depthTextureView ? { depthTextureView } : {}),
    },
  }
}

export default function createCompositePass(
  init: ThreeEffekseerPassInit,
  options: ThreeEffekseerPassOptions = {}
): ThreeEffekseerPass {
  const { renderer, scene, camera, effekseer } = init
  const tracker = options.idleOptimization === false
    ? null
    : createEffekseerActivityTracker(effekseer)
  const samples = Math.max(0, renderer.samples || 0)
  const capabilities: ThreeEffekseerPassCapabilities = {
    mode: 'composite',
    supportsDistortion: true,
    supportsDepthOcclusion: true,
    supportsSoftParticles: true,
    supportsLOD: false,
    supportsCollisions: false,
  }
  const scenePass = THREE.TSL.pass(scene, camera) as ThreeEffekseerPassNodeLike
  const sceneCaptureTrigger = createSceneCaptureTrigger(renderer, scenePass, samples)
  const softParticleDepthTarget = new THREE.RenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: false,
    samples: 0,
  })
  softParticleDepthTarget.texture.minFilter = THREE.NearestFilter
  softParticleDepthTarget.texture.magFilter = THREE.NearestFilter
  softParticleDepthTarget.texture.generateMipmaps = false
  softParticleDepthTarget.texture.name = 'ThreeEffekseer.softParticleDepth'
  const softParticleDepthCaptureTrigger = createSoftParticleDepthCaptureTrigger(
    renderer,
    scenePass,
    softParticleDepthTarget
  )
  let softParticleDepthEnabled = true
  const compositionTarget = new THREE.RenderTarget(1, 1, {
    type: renderer.getOutputBufferType(),
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: true,
    samples,
  })
  compositionTarget.texture.name = 'ThreeEffekseer.composition'
  const drawingBufferSize = new THREE.Vector2()

  const scenePassResources: ThreeEffekseerScenePassResources = {
    scenePass,
    renderTarget: scenePass.renderTarget,
    colorTexture: scenePass.renderTarget.texture,
    depthTexture: scenePass.renderTarget.depthTexture,
    nativeColorTexture: null,
    nativeColorTextureView: null,
    nativeDepthTexture: null,
    nativeDepthTextureView: null,
  }

  const compositePresenter = createCompositePassPresenter({
    renderer,
    scene,
    camera,
    renderTarget: compositionTarget,
    resolveCompositePassState: (_input, info) => createFinalPassState(
      renderer,
      scenePassResources,
      softParticleDepthEnabled ? softParticleDepthTarget : null,
      info
    ),
  })
  const presenter = createFinalPassPresenter({ renderer })

  return {
    getCapabilities() {
      return capabilities
    },

    resize(width, height, pixelRatio) {
      renderer.setPixelRatio(pixelRatio)
      renderer.setSize(width, height, false)
      renderer.getDrawingBufferSize(drawingBufferSize)
      softParticleDepthTarget.setSize(drawingBufferSize.width, drawingBufferSize.height)
      compositionTarget.setSize(drawingBufferSize.width, drawingBufferSize.height)
      updateCameraProjection(camera, width, height)
      sceneCaptureTrigger.resize(width, height, pixelRatio)
      softParticleDepthCaptureTrigger.resize(width, height, pixelRatio)
      compositePresenter.resize(width, height, pixelRatio)
      presenter.resize(width, height, pixelRatio)
    },

    render(deltaFrames) {
      const shouldRunEffekseer = tracker ? tracker.beforeFrame() : true
      if (!shouldRunEffekseer) {
        renderer.render(scene, camera)
        return
      }

      try {
        syncEffekseerCamera(camera, effekseer)
        effekseer.update(deltaFrames)
        sceneCaptureTrigger.render()
        if (softParticleDepthEnabled) {
          try {
            softParticleDepthCaptureTrigger.render()
          } catch {
            softParticleDepthEnabled = false
          }
        }
        scenePassResources.renderTarget = scenePass.renderTarget
        scenePassResources.colorTexture = scenePass.renderTarget.texture
        scenePassResources.depthTexture = scenePass.renderTarget.depthTexture
        compositePresenter.render({
          scenePassResources,
          effekseer,
        })
        presenter.render(compositionTarget.texture)
      } finally {
        tracker?.afterFrame()
      }
    },

    dispose() {
      tracker?.dispose()
      sceneCaptureTrigger.dispose()
      softParticleDepthCaptureTrigger.dispose()
      compositePresenter.dispose()
      presenter.dispose()
      softParticleDepthTarget.dispose()
      compositionTarget.dispose()
    },
  }
}
