import * as THREE from 'three/webgpu'
import type {
  ThreeEffekseerFinalPassPresenter,
} from './internalTypes'

type CreateFinalPassPresenterInit = {
  renderer: THREE.WebGPURenderer
}

export default function createFinalPassPresenter(
  init: CreateFinalPassPresenterInit
): ThreeEffekseerFinalPassPresenter {
  const { renderer } = init
  const postProcessing = new THREE.PostProcessing(renderer)

  let sourceTexture: THREE.Texture | null = null

  const updateOutputNode = (texture: THREE.Texture) => {
    if (sourceTexture === texture) {
      return
    }

    sourceTexture = texture
    postProcessing.outputNode = THREE.TSL.texture(texture)
    postProcessing.needsUpdate = true
  }

  return {
    render(texture) {
      updateOutputNode(texture)
      postProcessing.render()
    },

    resize() {
      postProcessing.needsUpdate = true
    },

    dispose() {
      postProcessing.dispose()
    },
  }
}
