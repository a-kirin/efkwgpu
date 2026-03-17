import * as THREE from 'three/webgpu'

function writeResult(text) {
  const el = document.getElementById('result')
  if (el) {
    el.innerHTML += text + '<br />'
  }
}

function writeResultGPUTime(text) {
  const el = document.getElementById('result_gputime')
  if (el) {
    el.innerHTML += text + '<br />'
  }
}

class RenderContext {
  constructor() {
    this.context = null
    this.renderer = null
    this.filePaths = []
    this.effects = []
    this.currentIndex = 0
    this.currentTime = -1
    this.updateTime = 0
    this.drawTime = 0
    this.scene = null
    this.camera = null
  }

  progress() {
    if (!this.context || !this.renderer || !this.scene || !this.camera) {
      return
    }

    if (this.currentTime === -1) {
      if (this.filePaths.length <= this.currentIndex) {
        for (let i = 0; i < 5; i += 1) {
          this.context.update(1.0)
        }

        for (let i = 0; i < this.effects.length; i += 1) {
          this.context.releaseEffect(this.effects[i])
        }

        return
      }
      this.context.play(this.effects[this.currentIndex])
      this.currentTime = 0
      this.updateTime = 0
      this.drawTime = 0
    }

    const startUpdateTime = performance.now()
    this.context.update(1.0)
    const endUpdateTime = performance.now()

    let drawTimeThisFrame = 0
    const previousHook = this.renderer.getExternalRenderPassHook()
    this.renderer.setExternalRenderPassHook((info) => {
      previousHook?.(info)
      if (info.camera !== this.camera) {
        return
      }

      const drawStart = performance.now()
      this.camera.updateMatrixWorld()
      this.context.setProjectionMatrix(this.camera.projectionMatrix.elements)
      this.context.setCameraMatrix(this.camera.matrixWorldInverse.elements)
      this.context.drawExternal(info.renderPassEncoder, {
        colorFormat: info.colorFormat,
        depthFormat: info.depthStencilFormat,
        sampleCount: info.sampleCount,
      })
      drawTimeThisFrame += performance.now() - drawStart
    })

    try {
      this.renderer.render(this.scene, this.camera)
    } finally {
      this.renderer.setExternalRenderPassHook(previousHook)
    }

    this.currentTime += 1
    this.updateTime += (endUpdateTime - startUpdateTime)
    this.drawTime += drawTimeThisFrame

    if (this.currentTime > 60) {
      writeResult(`${this.filePaths[this.currentIndex]},${this.updateTime.toFixed(2)},${this.drawTime.toFixed(2)}`)
      this.context.stopAll()
      this.currentIndex += 1
      this.currentTime = -1
    }

    requestAnimationFrame(() => {
      this.progress()
    })
  }
}

writeResult('Path,Update(ms),Draw(ms)')
writeResultGPUTime('GPU timing no disponible en WebGPU JS runtime actual.')

const renderContext = new RenderContext()
const canvas = document.getElementById('canvas')

if (!canvas) {
  writeResult('Canvas no encontrado')
} else if (!('gpu' in navigator)) {
  writeResult('WebGPU no disponible en este navegador')
} else if (!window.effekseer) {
  writeResult('Effekseer WebGPU runtime no cargado')
} else {
  renderContext.scene = new THREE.Scene()
  const width = canvas.width
  const height = canvas.height
  renderContext.camera = new THREE.PerspectiveCamera(30, width / height, 1, 1000)
  renderContext.camera.position.set(10, 10, 10)
  renderContext.camera.lookAt(new THREE.Vector3(0, 0, 0))

  renderContext.filePaths = [
    'Resources/Arrow1.efkwg',
    'Resources/Blow1.efkwg',
    'Resources/Cure1.efkwg',
    'Resources/Light.efkefc',
    'Resources/ToonHit.efkefc',
    'Resources/ToonWater.efkefc',
  ]

  renderContext.effects = []

  renderContext.renderer = new THREE.WebGPURenderer({ canvas, antialias: false })
  renderContext.renderer.setSize(width, height)

  const effekseerApi = window.effekseer

  const init = async () => {
    try {
      await renderContext.renderer.init()
      const device = renderContext.renderer.backend?.device
      if (!device) {
        throw new Error('WebGPU device no disponible desde Three.js')
      }

      effekseerApi.setWebGPUDevice(device)
      await effekseerApi.initRuntime('/effekseer-runtime/Effekseer_WebGPU_Runtime.wasm')

      renderContext.context = effekseerApi.createContext()
      if (!renderContext.context) {
        throw new Error('createContext() devolvio null')
      }

      const settings = {
        instanceMaxCount: 20000,
        squareMaxCount: 20000,
        externalRenderPass: true,
      }

      const initialized = typeof renderContext.context.initExternal === 'function'
        ? renderContext.context.initExternal(settings)
        : renderContext.context.init(canvas, settings)

      if (!initialized) {
        throw new Error('context.init fallo')
      }

      const grid = new THREE.GridHelper(20, 10, 0xffffff, 0xffffff)
      renderContext.scene.add(grid)

      const directionalLight = new THREE.DirectionalLight(0xffffff)
      directionalLight.position.set(0, 0.7, 0.7)
      renderContext.scene.add(directionalLight)

      for (let fi = 0; fi < renderContext.filePaths.length; fi += 1) {
        renderContext.effects.push(renderContext.context.loadEffect(renderContext.filePaths[fi], 1.0, () => {
          let canStart = true
          for (let i = 0; i < renderContext.effects.length; i += 1) {
            if (!renderContext.effects[i].isLoaded) {
              canStart = false
            }
          }
          if (canStart) {
            renderContext.progress()
          }
        }))
      }
    } catch (err) {
      writeResult(String(err && err.stack ? err.stack : err))
    }
  }

  init()
}
