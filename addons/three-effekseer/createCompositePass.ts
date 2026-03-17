import * as THREE from 'three/webgpu'
import type { ExternalRenderPassHookInfo } from 'three/webgpu'
import { syncEffekseerCamera, updateCameraProjection } from './common'
import createCompositePassPresenter from './createCompositePassPresenter'
import createFinalPassPresenter from './createFinalPassPresenter'
import type {
  ThreeEffekseerPass,
  ThreeEffekseerPassCapabilities,
  ThreeEffekseerPassInit,
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
  info: ExternalRenderPassHookInfo
): ThreeEffekseerFinalPassState | null {
  syncScenePassResources(renderer, scenePassResources)

  const backgroundTextureView = scenePassResources.nativeColorTextureView

  return {
    backgroundTextureView,
    depthTextureView: null,
    effekseerPassState: {
      colorFormat: info.colorFormat,
      depthFormat: info.depthStencilFormat,
      sampleCount: info.sampleCount,
      ...(backgroundTextureView ? { backgroundTextureView } : {}),
    },
  }
}

export default function createCompositePass(
  init: ThreeEffekseerPassInit
): ThreeEffekseerPass {
  const { renderer, scene, camera, effekseer } = init
  const samples = Math.max(0, renderer.samples || 0)
  const capabilities: ThreeEffekseerPassCapabilities = {
    mode: 'composite',
    supportsDistortion: true,
    supportsDepthOcclusion: true,
    supportsSoftParticles: false,
    supportsLOD: false,
    supportsCollisions: false,
  }
  const scenePass = THREE.TSL.pass(scene, camera) as ThreeEffekseerPassNodeLike
  const sceneCaptureTrigger = createSceneCaptureTrigger(renderer, scenePass, samples)
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
    resolveCompositePassState: (_input, info) => createFinalPassState(renderer, scenePassResources, info),
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
      compositionTarget.setSize(drawingBufferSize.width, drawingBufferSize.height)
      updateCameraProjection(camera, width, height)
      sceneCaptureTrigger.resize(width, height, pixelRatio)
      compositePresenter.resize(width, height, pixelRatio)
      presenter.resize(width, height, pixelRatio)
    },

    render(deltaFrames) {
      syncEffekseerCamera(camera, effekseer)
      effekseer.update(deltaFrames)
      sceneCaptureTrigger.render()
      scenePassResources.renderTarget = scenePass.renderTarget
      scenePassResources.colorTexture = scenePass.renderTarget.texture
      scenePassResources.depthTexture = scenePass.renderTarget.depthTexture
      compositePresenter.render({
        scenePassResources,
        effekseer,
      })
      presenter.render(compositionTarget.texture)
    },

    dispose() {
      sceneCaptureTrigger.dispose()
      compositePresenter.dispose()
      presenter.dispose()
      compositionTarget.dispose()
    },
  }
}
