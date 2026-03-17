import * as THREE from 'three/webgpu'
import type { ExternalRenderPassHookInfo } from 'three/webgpu'
import type {
  ThreeEffekseerComposePassPresenter,
  ResolveCompositePassState,
} from './internalTypes'

type CreateCompositePassPresenterInit = {
  renderer: THREE.WebGPURenderer
  scene: THREE.Scene
  camera: THREE.Camera
  renderTarget: THREE.RenderTarget
  resolveCompositePassState: ResolveCompositePassState
}

function isCompositePass(
  info: ExternalRenderPassHookInfo,
  renderTarget: THREE.RenderTarget,
  camera: THREE.Camera
): boolean {
  return info.renderTarget === renderTarget && info.camera === camera
}

export default function createCompositePassPresenter(
  init: CreateCompositePassPresenterInit
): ThreeEffekseerComposePassPresenter {
  const { renderer, scene, camera, renderTarget, resolveCompositePassState } = init

  return {
    render(input) {
      const previousHook = renderer.getExternalRenderPassHook()
      const previousRenderTarget = renderer.getRenderTarget()
      const previousActiveCubeFace = renderer.getActiveCubeFace()
      const previousActiveMipmapLevel = renderer.getActiveMipmapLevel()

      renderer.setRenderTarget(renderTarget)
      renderer.setExternalRenderPassHook((info: ExternalRenderPassHookInfo) => {
        previousHook?.(info)

        if (!isCompositePass(info, renderTarget, camera)) {
          return
        }

        const compositePassState = resolveCompositePassState(input, info)
        if (!compositePassState) {
          return
        }

        input.effekseer.drawExternal(info.renderPassEncoder, compositePassState.effekseerPassState)
      })

      try {
        renderer.render(scene, camera)
      } finally {
        renderer.setExternalRenderPassHook(previousHook)
        renderer.setRenderTarget(
          previousRenderTarget,
          previousActiveCubeFace,
          previousActiveMipmapLevel
        )
      }
    },

    resize() {},

    dispose() {},
  }
}
