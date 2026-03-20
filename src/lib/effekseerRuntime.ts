const EFFEKSEER_RUNTIME_BASE = (() => {
  const raw = (import.meta.env.VITE_EFFEKSEER_RUNTIME_BASE || '/effekseer-runtime').trim()
  if (!raw) return '/effekseer-runtime'
  return raw.replace(/\/+$/, '')
})()

export const EFFEKSEER_RUNTIME_WASM_URL = `${EFFEKSEER_RUNTIME_BASE}/Effekseer_WebGPU_Runtime.wasm`

declare global {
  interface Window {
    __effekseerRuntimeLoadPromise__?: Promise<void>
  }
}

const loadScriptOnce = (src: string): Promise<void> => {
  const absoluteSrc = new URL(src, window.location.href).href
  const existing = Array.from(document.querySelectorAll('script')).find((script) => script.src === absoluteSrc)
  if (existing) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = absoluteSrc
    script.async = false
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load runtime script: ${src}`))
    document.head.appendChild(script)
  })
}

export const ensureEffekseerRuntimeLoaded = async (): Promise<void> => {
  if (window.effekseer) return
  if (!window.__effekseerRuntimeLoadPromise__) {
    window.__effekseerRuntimeLoadPromise__ = (async () => {
      await loadScriptOnce(`${EFFEKSEER_RUNTIME_BASE}/fflate.umd.js`)
      await loadScriptOnce(`${EFFEKSEER_RUNTIME_BASE}/Effekseer_WebGPU_Runtime.js`)
      await loadScriptOnce(`${EFFEKSEER_RUNTIME_BASE}/effekseer.webgpu.src.js`)
      if (!window.effekseer) {
        throw new Error(`Effekseer runtime did not initialize from ${EFFEKSEER_RUNTIME_BASE}`)
      }
    })().catch((error) => {
      window.__effekseerRuntimeLoadPromise__ = undefined
      throw error
    })
  }
  await window.__effekseerRuntimeLoadPromise__
}
