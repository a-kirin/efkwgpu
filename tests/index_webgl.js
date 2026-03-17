const statusEl = document.getElementById('status')
const errorEl = document.getElementById('error')
const logEl = document.getElementById('log')
const buttons = document.getElementById('buttons')

const logLine = (message) => {
  const time = new Date().toISOString().split('T')[1]?.replace('Z', '') ?? ''
  const line = time ? `[${time}] ${message}` : message
  console.log(`[webgl-test] ${message}`)
  if (logEl) {
    logEl.textContent += `${line}\n`
    logEl.scrollTop = logEl.scrollHeight
  }
}

logLine('BUILD_TAG: index_webgl.js 2026-03-17T17:46Z')

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

function main() {
  const canvas = document.getElementById('canvas')
  if (!canvas) {
    setError('Canvas no disponible.')
    return
  }

  if (typeof window.THREE === 'undefined') {
    setError('THREE no está cargado. Revisa tests/index_webgl.html')
    return
  }

  const THREE = window.THREE
  const renderer = new THREE.WebGLRenderer({ canvas })
  renderer.setSize(canvas.width, canvas.height)
  renderer.setClearColor(0xdbe2ea, 1)
  const clock = new THREE.Clock()
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30.0, canvas.width / canvas.height, 1, 1000)
  camera.position.set(20, 20, 20)
  camera.lookAt(new THREE.Vector3(0, 0, 0))

  const grid = new THREE.GridHelper(20, 10, 0xffffff, 0xffffff)
  scene.add(grid)
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshBasicMaterial({ color: 0xff4444 })
  )
  cube.position.set(0, 1, 0)
  scene.add(cube)

  const context = effekseer.createContext()
  context.init(renderer.getContext())

  const fastRenderMode = false
  if (fastRenderMode) {
    context.setRestorationOfStatesFlag(false)
  }

  const effectPath = 'Resources/Arrow1.efkwg'
  logLine(`loadEffect: ${effectPath}`)
  let effectReady = false
  const effect = context.loadEffect(effectPath, 1.0, () => {
    effectReady = true
    logLine(`loadEffect ok: ${effectPath}`)
    const handle = context.play(effect)
    if (handle) {
      handle.setLocation(0, 0, 0)
      if (handle.setScale) {
        handle.setScale(3, 3, 3)
      }
      window.latestHandle = handle
      setStatus('Play: Arrow1.efkwg')
      logLine('handle created: true')
    } else {
      logLine('play returned null handle')
    }
  }, (message, failedPath) => {
    logLine(`loadEffect error: ${message} ${failedPath || effectPath}`)
    setError(`loadEffect error: ${message}`)
  })

  if (!effect) {
    logLine('loadEffect returned null')
  }

  if (buttons) {
    const btn = document.createElement('input')
    btn.type = 'button'
    btn.value = 'Arrow1.efkwg'
    btn.id = 'Arrow1.efkwg'
    btn.addEventListener('click', () => {
      if (!effectReady) {
        logLine('play blocked: effect not ready yet')
        return
      }
      setStatus('Play: Arrow1.efkwg')
      logLine('play: Arrow1.efkwg')
      const handle = context.play(effect)
      if (handle) {
        handle.setLocation(0, 0, 0)
        if (handle.setScale) {
          handle.setScale(3, 3, 3)
        }
        window.latestHandle = handle
      } else {
        logLine('play returned null handle')
      }
    })
    buttons.appendChild(btn)
  }

  const renderLoop = () => {
    requestAnimationFrame(renderLoop)

    context.update(clock.getDelta() * 60.0)
    renderer.render(scene, camera)
    context.setProjectionMatrix(camera.projectionMatrix.elements)
    context.setCameraMatrix(camera.matrixWorldInverse.elements)
    context.draw()
  }

  logLine('renderLoop start')
  renderLoop()
}

if (!window.effekseer) {
  logLine('Effekseer runtime no disponible.')
  setError('Effekseer runtime no disponible.')
} else {
  logLine('Modulo cargado: index_webgl.js')
  logLine(`effekseerApi.init: ${typeof effekseer.init}`)
  logLine(`effekseerApi.initRuntime: ${typeof effekseer.initRuntime}`)
  logLine(`effekseer_native: ${typeof window.effekseer_native}`)
  logLine(`effekseerApi.loadEffect: ${typeof effekseer.loadEffect}`)

  logLine('initRuntime: /effekseer-webgl/effekseer.wasm')
  effekseer.initRuntime('/effekseer-webgl/effekseer.wasm', () => {
    logLine('initRuntime ok')
    effekseer.setLogEnabled?.(true)
    main()
  }, () => {
    setError('initRuntime failed')
  })
}
