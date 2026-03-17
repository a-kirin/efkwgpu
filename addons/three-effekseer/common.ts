import type { Camera } from 'three'
import type { EffekseerContext } from './effekseer-webgpu-types'

export function updateCameraProjection(camera: Camera, width: number, height: number): void {
  const cameraWithProjection = camera as Camera & {
    isPerspectiveCamera?: boolean
    aspect?: number
    updateProjectionMatrix?: () => void
  }

  if (cameraWithProjection.isPerspectiveCamera === true && typeof cameraWithProjection.aspect === 'number') {
    cameraWithProjection.aspect = width / height
  }

  cameraWithProjection.updateProjectionMatrix?.()
}

export function syncEffekseerCamera(
  camera: Camera,
  effekseer: EffekseerContext
): void {
  camera.updateMatrixWorld()
  effekseer.setProjectionMatrix(camera.projectionMatrix.elements)
  effekseer.setCameraMatrix(camera.matrixWorldInverse.elements)
}
