import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const EXAMPLES_WEBGPU_DIR = fileURLToPath(
  new URL('../', import.meta.url)
)
const PUBLIC_RUNTIME_DIR = fileURLToPath(
  new URL('./public/effekseer-runtime/', import.meta.url)
)
const PUBLIC_WRAPPER_FILE = fileURLToPath(
  new URL('./public/effekseer-runtime/effekseer.webgpu.src.js', import.meta.url)
)

const EFFEKSEER_RUNTIME_DIR = process.env.EFFEKSEER_RUNTIME_DIR
  ? path.resolve(process.env.EFFEKSEER_RUNTIME_DIR)
  : PUBLIC_RUNTIME_DIR
const EFFEKSEER_WRAPPER_FILE = process.env.EFFEKSEER_WRAPPER_FILE
  ? path.resolve(process.env.EFFEKSEER_WRAPPER_FILE)
  : PUBLIC_WRAPPER_FILE
const EFFEKSEER_FFLATE_FILE = existsSync(path.join(EFFEKSEER_RUNTIME_DIR, 'fflate.umd.js'))
  ? path.join(EFFEKSEER_RUNTIME_DIR, 'fflate.umd.js')
  : path.join(PUBLIC_RUNTIME_DIR, 'fflate.umd.js')

const PROJECT_ROOT_DIR = fileURLToPath(
  new URL('./', import.meta.url)
)

const PKMOVES_SRC_DIR = fileURLToPath(
  new URL('./src/pkmoves', import.meta.url)
)

const TESTS_DIR = fileURLToPath(
  new URL('./tests', import.meta.url)
)

const EFFEKSEER_RUNTIME_PUBLIC_PATH = '/effekseer-runtime'
const EFFEKSEER_RUNTIME_BUILD_TOP_PATH = '/build_top/Examples/WebGPU'

const EFFEKSEER_RUNTIME_FILES = new Map<string, string>([
  [`${EFFEKSEER_RUNTIME_PUBLIC_PATH}/effekseer.webgpu.src.js`, EFFEKSEER_WRAPPER_FILE],
  [`${EFFEKSEER_RUNTIME_PUBLIC_PATH}/Effekseer_WebGPU_Runtime.js`, path.join(EFFEKSEER_RUNTIME_DIR, 'Effekseer_WebGPU_Runtime.js')],
  [`${EFFEKSEER_RUNTIME_PUBLIC_PATH}/Effekseer_WebGPU_Runtime.wasm`, path.join(EFFEKSEER_RUNTIME_DIR, 'Effekseer_WebGPU_Runtime.wasm')],
  [`${EFFEKSEER_RUNTIME_PUBLIC_PATH}/fflate.umd.js`, EFFEKSEER_FFLATE_FILE],
  [`${EFFEKSEER_RUNTIME_BUILD_TOP_PATH}/effekseer.webgpu.src.js`, EFFEKSEER_WRAPPER_FILE],
  [`${EFFEKSEER_RUNTIME_BUILD_TOP_PATH}/Effekseer_WebGPU_Runtime.js`, path.join(EFFEKSEER_RUNTIME_DIR, 'Effekseer_WebGPU_Runtime.js')],
  [`${EFFEKSEER_RUNTIME_BUILD_TOP_PATH}/Effekseer_WebGPU_Runtime.wasm`, path.join(EFFEKSEER_RUNTIME_DIR, 'Effekseer_WebGPU_Runtime.wasm')],
  [`${EFFEKSEER_RUNTIME_BUILD_TOP_PATH}/fflate.umd.js`, EFFEKSEER_FFLATE_FILE],
])

const BUILD_INPUTS = Object.fromEntries(
  Object.entries({
    app: fileURLToPath(new URL('./index.html', import.meta.url)),
    vanilla: fileURLToPath(new URL('./vanilla/index.html', import.meta.url)),
    canvasOnly: fileURLToPath(new URL('./canvas-only/index.html', import.meta.url)),
    testsIndexWebgpu: fileURLToPath(new URL('./tests/index_webgpu.html', import.meta.url)),
    testsIndexWebgpuSample: fileURLToPath(new URL('./tests/index_webgpu_sample.html', import.meta.url)),
    testsIndexCanvasOnly: fileURLToPath(new URL('./tests/index_canvas_only.html', import.meta.url)),
    testsIndexWebgl: fileURLToPath(new URL('./tests/index_webgl.html', import.meta.url)),
    testsPerformanceWebgpu: fileURLToPath(new URL('./tests/performance_webgpu.html', import.meta.url)),
    testsPostProcessingWebgpu: fileURLToPath(new URL('./tests/post_processing_threejs_webgpu.html', import.meta.url)),
    testsPremultipliedWebgpu: fileURLToPath(new URL('./tests/premultiplied_alpha_webgpu.html', import.meta.url)),
  }).filter(([, filePath]) => existsSync(filePath))
)

function getContentType(urlPath: string): string {
  if (urlPath.endsWith('.wasm')) {
    return 'application/wasm'
  }

  return 'text/javascript; charset=utf-8'
}

function getStaticContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.bmp':
      return 'image/bmp'
    case '.dds':
      return 'application/octet-stream'
    case '.efkefc':
    case '.efkwg':
    case '.efkwgpk':
    case '.efkpkg':
    case '.efkmat':
    case '.efkmatd':
    case '.efkmodel':
      return 'application/octet-stream'
    default:
      return 'application/octet-stream'
  }
}

function effekseerRuntimePlugin() {
  return {
    name: 'effekseer-runtime-canonical',

    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const urlPath = req.url ? req.url.split('?')[0] : ''

        if (urlPath.startsWith('/pkmoves/')) {
          const relativePath = urlPath.replace('/pkmoves/', '')
          const sourcePath = path.resolve(PKMOVES_SRC_DIR, relativePath)
          if (sourcePath.startsWith(PKMOVES_SRC_DIR) && existsSync(sourcePath)) {
            try {
              const file = await readFile(sourcePath)
              res.statusCode = 200
              res.setHeader('Content-Type', getStaticContentType(sourcePath))
              res.end(file)
            } catch (error) {
              next(error as Error)
            }
            return
          }
        }

        if (urlPath.startsWith('/tests/input/') || urlPath.startsWith('/tests/Resources/')) {
          const relativePath = urlPath.startsWith('/tests/input/')
            ? urlPath.replace('/tests/input/', '')
            : urlPath.replace('/tests/Resources/', '')
          const sourcePath = path.join(TESTS_DIR, 'Resources', relativePath)
          if (existsSync(sourcePath)) {
            try {
              const file = await readFile(sourcePath)
              res.statusCode = 200
              res.setHeader('Content-Type', getStaticContentType(sourcePath))
              res.end(file)
            } catch (error) {
              next(error as Error)
            }
            return
          }
        }

        const sourcePath = EFFEKSEER_RUNTIME_FILES.get(urlPath)

        if (!sourcePath) {
          next()
          return
        }

        try {
          const file = await readFile(sourcePath)
          res.statusCode = 200
          res.setHeader('Content-Type', getContentType(urlPath))
          res.end(file)
        } catch (error) {
          next(error as Error)
        }
      })
    },

    async writeBundle() {
      const distRuntimeDir = path.join(process.cwd(), 'dist', EFFEKSEER_RUNTIME_PUBLIC_PATH.slice(1))
      await mkdir(distRuntimeDir, { recursive: true })

      for (const [urlPath, sourcePath] of EFFEKSEER_RUNTIME_FILES) {
        await copyFile(sourcePath, path.join(distRuntimeDir, path.basename(urlPath)))
      }

      const copyDir = async (src: string, dest: string): Promise<void> => {
        let entries: Array<import('node:fs').Dirent>
        try {
          entries = await readdir(src, { withFileTypes: true })
        } catch {
          return
        }

        await mkdir(dest, { recursive: true })

        for (const entry of entries) {
          const srcPath = path.join(src, entry.name)
          const destPath = path.join(dest, entry.name)
          if (entry.isDirectory()) {
            await copyDir(srcPath, destPath)
            continue
          }
          if (entry.isFile()) {
            await copyFile(srcPath, destPath)
          }
        }
      }

      await copyDir(path.join(TESTS_DIR, 'Resources'), path.join(process.cwd(), 'dist', 'tests', 'Resources'))
      await copyDir(path.join(TESTS_DIR, 'Resources'), path.join(process.cwd(), 'dist', 'tests', 'input'))
      await copyDir(path.join(TESTS_DIR, 'vendor'), path.join(process.cwd(), 'dist', 'tests', 'vendor'))
      await copyDir(PKMOVES_SRC_DIR, path.join(process.cwd(), 'dist', 'pkmoves'))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), effekseerRuntimePlugin()],
  assetsInclude: ['**/*.efkwgpk'],
  resolve: {
    alias: [
      {
        find: 'three-effekseer',
        replacement: fileURLToPath(
          new URL('./addons/three-effekseer/index.ts', import.meta.url)
        ),
      },
      {
        find: 'three/webgpu',
        replacement: fileURLToPath(
          new URL('./vendor/three/three.webgpu.js', import.meta.url)
        ),
      },
      {
        find: 'three/addons/controls/OrbitControls.js',
        replacement: fileURLToPath(
          new URL('./vendor/three/addons/controls/OrbitControls.js', import.meta.url)
        ),
      },
      {
        find: /^three$/,
        replacement: fileURLToPath(
          new URL('./vendor/three/three.core.js', import.meta.url)
        ),
      },
    ],
  },
  server: {
    fs: {
      allow: [PROJECT_ROOT_DIR, EFFEKSEER_RUNTIME_DIR, TESTS_DIR, EXAMPLES_WEBGPU_DIR, path.dirname(EFFEKSEER_WRAPPER_FILE)],
    },
  },
  build: {
    rollupOptions: {
      input: BUILD_INPUTS,
    },
  },
})
