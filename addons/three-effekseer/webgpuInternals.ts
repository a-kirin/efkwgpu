import * as THREE from 'three/webgpu'
import type { Texture } from 'three'

type WebGPUBackendWithTextureStore = {
  get(object: object): { texture?: GPUTexture }
}

type PostProcessingWithQuad = THREE.PostProcessing & {
  _quadMesh?: {
    material?: THREE.Material
  }
}

export function getNativeGPUTexture(
  renderer: THREE.WebGPURenderer,
  texture: Texture
): GPUTexture | null {
  // Uses Three's current WebGPU internal store: renderer.backend.get(texture).texture.
  // Three does not expose a public native GPUTexture handle yet, so this access stays isolated here.
  const nativeTexture = (renderer.backend as unknown as WebGPUBackendWithTextureStore).get(texture).texture

  return nativeTexture ?? null
}

export function configureOverlayPostProcessingMaterial(
  postProcessing: THREE.PostProcessing
): void {
  const quadMesh = (postProcessing as PostProcessingWithQuad)._quadMesh

  if (!quadMesh?.material) {
    throw new Error(
      'configureOverlayPostProcessingMaterial: expected PostProcessing._quadMesh.material.'
    )
  }

  quadMesh.material.depthTest = false
  quadMesh.material.depthWrite = false
  quadMesh.material.needsUpdate = true
}
