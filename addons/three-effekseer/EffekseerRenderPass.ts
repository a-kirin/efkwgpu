import type { Camera, Scene } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type { EffekseerContext } from './effekseer-webgpu-types'
import createThreeEffekseerPass from './ThreeEffekseerPass'
import type {
  ThreeEffekseerPass,
  ThreeEffekseerPassCapabilities,
  ThreeEffekseerPassOptions,
} from './types'

class EffekseerRenderPass {
  private readonly pass: ThreeEffekseerPass

  constructor(
    renderer: WebGPURenderer,
    scene: Scene,
    camera: Camera,
    effekseer: EffekseerContext,
    options: ThreeEffekseerPassOptions = {}
  ) {
    this.pass = createThreeEffekseerPass(
      {
        renderer,
        scene,
        camera,
        effekseer,
      },
      options
    )
  }

  getCapabilities(): ThreeEffekseerPassCapabilities {
    return this.pass.getCapabilities()
  }

  setSize(width: number, height: number, pixelRatio = 1): void {
    this.pass.resize(width, height, pixelRatio)
  }

  render(deltaFrames = 1): void {
    this.pass.render(deltaFrames)
  }

  dispose(): void {
    this.pass.dispose()
  }
}

export default EffekseerRenderPass
