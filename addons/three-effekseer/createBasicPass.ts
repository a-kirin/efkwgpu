import type { ExternalRenderPassHookInfo } from 'three/webgpu'
import createEffekseerActivityTracker from './createEffekseerActivityTracker'
import { syncEffekseerCamera, updateCameraProjection } from './common'
import type {
  ThreeEffekseerPass,
  ThreeEffekseerPassCapabilities,
  ThreeEffekseerPassInit,
  ThreeEffekseerPassOptions,
} from './types'

function isPrimaryScenePass(camera: ThreeEffekseerPassInit['camera'], info: ExternalRenderPassHookInfo): boolean {
  return info.camera === camera
}

export default function createBasicPass(
  init: ThreeEffekseerPassInit,
  options: ThreeEffekseerPassOptions = {}
): ThreeEffekseerPass {
  const { renderer, scene, camera, effekseer } = init
  const tracker = options.idleOptimization === false
    ? null
    : createEffekseerActivityTracker(effekseer)
  const capabilities: ThreeEffekseerPassCapabilities = {
    mode: 'basic',
    supportsDistortion: false,
    supportsDepthOcclusion: true,
    supportsSoftParticles: false,
    supportsLOD: false,
    supportsCollisions: false,
  }

  return {
    getCapabilities() {
      return capabilities
    },

    resize(width, height, pixelRatio) {
      renderer.setPixelRatio(pixelRatio)
      renderer.setSize(width, height, false)
      updateCameraProjection(camera, width, height)
    },

    render(deltaFrames) {
      const shouldRunEffekseer = tracker ? tracker.beforeFrame() : true
      if (!shouldRunEffekseer) {
        renderer.render(scene, camera)
        return
      }

      const previousHook = renderer.getExternalRenderPassHook()

      renderer.setExternalRenderPassHook((info: ExternalRenderPassHookInfo) => {
        previousHook?.(info)

        if (!isPrimaryScenePass(camera, info)) {
          return
        }

        syncEffekseerCamera(camera, effekseer)
        effekseer.drawExternal(info.renderPassEncoder, {
          colorFormat: info.colorFormat,
          depthFormat: info.depthStencilFormat,
          sampleCount: info.sampleCount,
        })
      })

      try {
        syncEffekseerCamera(camera, effekseer)
        effekseer.update(deltaFrames)
        renderer.render(scene, camera)
      } finally {
        renderer.setExternalRenderPassHook(previousHook)
        tracker?.afterFrame()
      }
    },

    dispose() {
      tracker?.dispose()
    },
  }
}
