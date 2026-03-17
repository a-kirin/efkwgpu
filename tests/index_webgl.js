const statusEl = document.getElementById('status')
const errorEl = document.getElementById('error')
const logEl = document.getElementById('log')

const logLine = (message) => {
  const time = new Date().toISOString().split('T')[1]?.replace('Z', '') ?? ''
  const line = time ? `[${time}] ${message}` : message
  console.log(`[webgl-test] ${message}`)
  if (logEl) {
    logEl.textContent += `${line}\n`
    logEl.scrollTop = logEl.scrollHeight
  }
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text || ''
}

function setError(text) {
  if (errorEl) errorEl.textContent = text || ''
}

window.capturePNG = function () {
  const canvas = document.getElementById('canvas')
  return canvas ? canvas.toDataURL('image/png').substring(21) : ''
}

window.callEstimateBoundingBox = function () {
  setStatus('callEstimateBoundingBox: no disponible en WebGL runtime actual.')
}

window.callExists = function () {
  const exists = !!(window.latestHandle && window.latestHandle.exists)
  setStatus('latestHandle.exists = ' + exists)
  return exists
}

const filePaths = [
  { name: 'blood.efkefc', path: 'Resources/blood.efkefc' },
]

const canvas = document.getElementById('canvas')
const effekseerApi = window.effekseer
const buttons = document.getElementById('buttons')

if (!canvas || !effekseerApi) {
  logLine(`canvas: ${!!canvas}, effekseerApi: ${!!effekseerApi}`)
  setError('Effekseer WebGL runtime no disponible en este navegador/contexto.')
} else {
  logLine('Modulo cargado: index_webgl.js')
  logLine(`effekseerApi.init: ${typeof effekseerApi.init}`)
  logLine(`effekseerApi.initRuntime: ${typeof effekseerApi.initRuntime}`)
  logLine(`effekseer_native: ${typeof window.effekseer_native}`)
  logLine(`effekseerApi.loadEffect: ${typeof effekseerApi.loadEffect}`)

  if (typeof window.THREE === 'undefined') {
    setError('THREE no está cargado. Revisa tests/index_webgl.html')
  } else {
    const THREE = window.THREE
    const scene = new THREE.Scene()
    const width = canvas.width
    const height = canvas.height
    const camera = new THREE.PerspectiveCamera(30, width / height, 1, 1000)
    camera.position.set(20, 20, 20)
    camera.lookAt(new THREE.Vector3(0, 0, 0))

    const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true })
    renderer.setSize(width, height, false)

    const grid = new THREE.GridHelper(20, 10, 0xffffff, 0xffffff)
    scene.add(grid)

    const directionalLight = new THREE.DirectionalLight(0xffffff)
    directionalLight.position.set(0, 0.7, 0.7)
    scene.add(directionalLight)

    const gl = renderer.getContext()
    const effects = {}

    const setupButtons = (context) => {
      if (!buttons) return
      filePaths.forEach(({ name, path }) => {
        logLine(`loadEffect: ${path}`)
        const effect = context.loadEffect(path, 1.0, () => {
          logLine(`loadEffect ok: ${path}`)
        }, (message, failedPath) => {
          logLine(`loadEffect error: ${message} ${failedPath || path}`)
        })
        effects[name] = effect

        const btn = document.createElement('input')
        btn.type = 'button'
        btn.value = name
        btn.id = name
        btn.addEventListener('click', () => {
          setStatus('Play: ' + name)
          logLine(`play: ${name}`)
          window.latestHandle = context.play(effect, 0, 0, 0)
        })
        buttons.appendChild(btn)
      })
    }

    const renderLoop = (context) => {
      context.update()
      renderer.render(scene, camera)
      context.setProjectionMatrix(camera.projectionMatrix.elements)
      context.setCameraMatrix(camera.matrixWorldInverse.elements)
      context.draw()
      requestAnimationFrame(() => renderLoop(context))
    }

    effekseerApi.initRuntime('/effekseer-webgl/effekseer.wasm', () => {
      const context = effekseerApi.createContext()
      if (!context) {
        setError('createContext() returned null')
        return
      }
      context.init(gl)
      setupButtons(context)
      setStatus('WebGL runtime listo.')
      setError('')
      logLine('renderLoop start')
      renderLoop(context)
    }, () => {
      setError('initRuntime failed')
    })
  }
}
