import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const DEFAULT_RUNTIME_DIR = fileURLToPath(
  new URL('./public/effekseer-runtime/', import.meta.url)
)

const EFFEKSEER_RUNTIME_DIR = process.env.EFFEKSEER_RUNTIME_DIR
  ? path.resolve(process.env.EFFEKSEER_RUNTIME_DIR)
  : DEFAULT_RUNTIME_DIR

const EFFEKSEER_ROOT_DIR = fileURLToPath(
  new URL('../../../', import.meta.url)
)

const NATIVE_CONVERTER_CSPROJ = fileURLToPath(
  new URL('../../../Dev/Editor/EffekseerNativeConverter/EffekseerNativeConverter.csproj', import.meta.url)
)

const MESH_INJECTOR_CSPROJ = fileURLToPath(
  new URL('../../../Dev/Editor/EffekseerMeshInjector/EffekseerMeshInjector.csproj', import.meta.url)
)

const DEFAULT_NATIVE_MESH_PATH = fileURLToPath(
  new URL('./public/fx/preview-text.efkmodel', import.meta.url)
)

const NATIVE_SEARCH_ROOTS = [
  path.join(EFFEKSEER_ROOT_DIR, 'Examples', 'Resources'),
  path.join(EFFEKSEER_ROOT_DIR, 'Examples', 'WebGPU', 'Sample'),
]

const EFFEKSEER_RUNTIME_PUBLIC_PATH = '/effekseer-runtime'

const EFFEKSEER_RUNTIME_FILES = new Map<string, string>([
  [`${EFFEKSEER_RUNTIME_PUBLIC_PATH}/effekseer.webgpu.src.js`, path.join(EFFEKSEER_RUNTIME_DIR, 'effekseer.webgpu.src.js')],
  [`${EFFEKSEER_RUNTIME_PUBLIC_PATH}/Effekseer_WebGPU_Runtime.js`, path.join(EFFEKSEER_RUNTIME_DIR, 'Effekseer_WebGPU_Runtime.js')],
  [`${EFFEKSEER_RUNTIME_PUBLIC_PATH}/Effekseer_WebGPU_Runtime.wasm`, path.join(EFFEKSEER_RUNTIME_DIR, 'Effekseer_WebGPU_Runtime.wasm')],
  [`${EFFEKSEER_RUNTIME_PUBLIC_PATH}/fflate.umd.js`, path.join(EFFEKSEER_RUNTIME_DIR, 'fflate.umd.js')],
])

function getContentType(urlPath: string): string {
  if (urlPath.endsWith('.wasm')) {
    return 'application/wasm'
  }

  return 'text/javascript; charset=utf-8'
}

type NativeConvertRequest = {
  sourceName: string
  sourceBase64: string
  injectMesh?: boolean
  deps?: Array<{
    name?: string
    relativePath?: string
    bytesBase64?: string
  }>
}

const parseJsonBody = async (req: import('node:http').IncomingMessage): Promise<NativeConvertRequest> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const body = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(body) as NativeConvertRequest
}

const decodeBase64 = (value: string): Uint8Array => {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

const encodeBase64 = (value: Uint8Array): string => {
  return Buffer.from(value).toString('base64')
}

const normalizeRelativePath = (input: string): string => {
  const normalized = String(input || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.')

  for (const segment of normalized) {
    if (segment === '..') {
      throw new Error(`invalid relative path: ${input}`)
    }
  }

  if (normalized.length === 0) {
    throw new Error('empty relative path')
  }

  return normalized.join('/')
}

const RESOURCE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.dds', '.tga', '.bmp',
  '.efkmodel', '.mqo', '.obj', '.fbx', '.gltf', '.glb',
  '.efkmat', '.efkmatd',
  '.wav', '.ogg', '.mp3',
])

const getCanonicalDependencyDirs = (ext: string): string[] => {
  switch (ext) {
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.dds':
    case '.tga':
    case '.bmp':
      return ['Texture', 'Textures']
    case '.efkmodel':
    case '.mqo':
    case '.obj':
    case '.fbx':
    case '.gltf':
    case '.glb':
      return ['Model', 'Models', 'mqo']
    case '.efkmat':
    case '.efkmatd':
      return ['Material', 'Materials']
    case '.wav':
    case '.ogg':
    case '.mp3':
      return ['Sound', 'Sounds']
    default:
      return []
  }
}

const resolveMeshPath = (): string => {
  const seed = DEFAULT_NATIVE_MESH_PATH

  const candidate = path.isAbsolute(seed)
    ? path.resolve(seed)
    : path.resolve(EFFEKSEER_ROOT_DIR, seed)

  const root = path.resolve(EFFEKSEER_ROOT_DIR)
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep
  const normalizedCandidate = path.resolve(candidate)
  if (
    normalizedCandidate !== root &&
    !normalizedCandidate.toLowerCase().startsWith(normalizedRoot.toLowerCase())
  ) {
    throw new Error(`meshPath must stay inside repo root: ${seed}`)
  }

  if (!existsSync(normalizedCandidate)) {
    throw new Error(`mesh file not found: ${normalizedCandidate}`)
  }

  return normalizedCandidate
}

const runCommand = (
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8')
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
      })
    })
  })
}

const parseDepsPackedFromToolOutput = (stdout: string): number | null => {
  const match = /\bDeps\s*:\s*(\d+)/i.exec(stdout || '')
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : null
}

const collectDependencySearchRoots = (inputRoot: string, relativePaths: string[]): string[] => {
  const output: string[] = []
  const seen = new Set<string>()

  for (const relPath of relativePaths) {
    const normalized = relPath.replace(/\\/g, '/')
    const parts = normalized.split('/').filter(Boolean)
    if (parts.length <= 1) continue

    for (let i = 1; i < parts.length; i++) {
      const root = path.join(inputRoot, ...parts.slice(0, i))
      const full = path.resolve(root)
      if (!existsSync(full) || seen.has(full)) continue
      seen.add(full)
      output.push(full)
    }
  }

  return output
}

const expandSearchRoots = async (roots: string[]): Promise<string[]> => {
  const output: string[] = []
  const seen = new Set<string>()

  const add = (candidate: string) => {
    const full = path.resolve(candidate)
    if (!existsSync(full) || seen.has(full)) return
    seen.add(full)
    output.push(full)
  }

  for (const root of roots) {
    add(root)
    try {
      const entries = await readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        add(path.join(root, entry.name))
      }
    } catch {
      // Ignore invalid/unreadable roots.
    }
  }

  return output
}

const TOOL_TFM = 'net8.0'
const pendingToolBuilds = new Map<string, Promise<string>>()
const NATIVE_BACKEND_REVISION = 'native-rev-2026-03-16-canonical-deps-mirror'

const getToolDllPath = (projectPath: string): string => {
  const projectDir = path.dirname(projectPath)
  const projectName = path.basename(projectPath, '.csproj')
  const debugDll = path.join(projectDir, 'bin', 'Debug', TOOL_TFM, `${projectName}.dll`)
  if (existsSync(debugDll)) {
    return debugDll
  }
  return path.join(projectDir, 'bin', 'Release', TOOL_TFM, `${projectName}.dll`)
}

const getNewestToolSourceMtimeMs = async (projectPath: string): Promise<number> => {
  const projectDir = path.dirname(projectPath)
  const stack = [projectDir]
  let newest = 0

  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.name === 'bin' || entry.name === 'obj') continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile()) continue

      const ext = path.extname(entry.name).toLowerCase()
      if (ext !== '.cs' && ext !== '.csproj' && ext !== '.props' && ext !== '.targets') continue
      try {
        const fileStat = await stat(fullPath)
        newest = Math.max(newest, fileStat.mtimeMs)
      } catch {
        // ignore races
      }
    }
  }

  return newest
}

const isToolDllStale = async (projectPath: string, dllPath: string): Promise<boolean> => {
  if (!existsSync(dllPath)) return true
  try {
    const dllStat = await stat(dllPath)
    const newestSource = await getNewestToolSourceMtimeMs(projectPath)
    return newestSource > dllStat.mtimeMs
  } catch {
    return true
  }
}

const ensureToolDll = async (projectPath: string): Promise<string> => {
  let pendingBuild = pendingToolBuilds.get(projectPath)
  if (!pendingBuild) {
    pendingBuild = (async () => {
      const existingDll = getToolDllPath(projectPath)
      const stale = await isToolDllStale(projectPath, existingDll)
      if (stale) {
        const buildResult = await runCommand(
          'dotnet',
          ['build', projectPath, '-c', 'Debug', '-nologo'],
          EFFEKSEER_ROOT_DIR
        )
        if (buildResult.code !== 0) {
          throw new Error(buildResult.stderr || buildResult.stdout || `dotnet build failed for ${projectPath}`)
        }
      }

      const builtDll = getToolDllPath(projectPath)
      if (!existsSync(builtDll)) {
        throw new Error(`converter DLL not found after build: ${builtDll}`)
      }
      return builtDll
    })()
    pendingToolBuilds.set(projectPath, pendingBuild)
  }

  try {
    return await pendingBuild
  } finally {
    pendingToolBuilds.delete(projectPath)
  }
}

const runDotnetTool = async (
  projectPath: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const dllPath = await ensureToolDll(projectPath)
  return runCommand('dotnet', [dllPath, ...args], EFFEKSEER_ROOT_DIR)
}

function effekseerRuntimePlugin() {
  return {
    name: 'effekseer-runtime-canonical',

    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const urlPath = req.url ? req.url.split('?')[0] : ''

        if (req.method === 'POST' && urlPath === '/api/native-convert') {
          let tempDir = ''
          try {
            const body = await parseJsonBody(req)
            if (!body.sourceName || !body.sourceBase64) {
              throw new Error('sourceName and sourceBase64 are required')
            }

            const sourceName = path.basename(body.sourceName)
            const sourceExt = path.extname(sourceName).toLowerCase()
            if (sourceExt !== '.efkefc' && sourceExt !== '.efkpkg') {
              throw new Error('native converter currently supports .efkefc or .efkpkg input')
            }

            const sourceBytes = decodeBase64(body.sourceBase64)
            tempDir = await mkdtemp(path.join(tmpdir(), 'effekseer-native-convert-'))
            const inputRoot = path.join(tempDir, 'input')
            const outputRoot = path.join(tempDir, 'output')
            await mkdir(inputRoot, { recursive: true })
            await mkdir(outputRoot, { recursive: true })

            const sourcePath = path.join(inputRoot, sourceName)
            await writeFile(sourcePath, sourceBytes)

            const deps = Array.isArray(body.deps) ? body.deps : []
            const depRelativePaths: string[] = []
            const depNameMap = new Map<string, string[]>()
            const stagedAliasPaths = new Set<string>()
            for (const dep of deps) {
              if (!dep?.bytesBase64) continue
              const depBytes = decodeBase64(dep.bytesBase64)
              const seedPath = dep.relativePath || dep.name || ''
              if (!seedPath) continue

              const relPath = normalizeRelativePath(seedPath)
              depRelativePaths.push(relPath)
              const ext = path.extname(relPath).toLowerCase()
              if (RESOURCE_EXTS.has(ext)) {
                const key = path.basename(relPath).toLowerCase()
                const list = depNameMap.get(key) ?? []
                list.push(relPath)
                depNameMap.set(key, list)
              }
              const depPath = path.join(inputRoot, relPath)
              await mkdir(path.dirname(depPath), { recursive: true })
              await writeFile(depPath, depBytes)
              stagedAliasPaths.add(path.resolve(depPath).toLowerCase())

              // Mirror each dependency into canonical folders (Texture/Model/Material/Sound)
              // so Core.LoadFrom() resolves paths before export.
              const depBaseName = path.basename(relPath)
              const canonicalDirs = getCanonicalDependencyDirs(ext)
              for (const canonicalDir of canonicalDirs) {
                const aliasPath = path.join(inputRoot, canonicalDir, depBaseName)
                const normalizedAlias = path.resolve(aliasPath).toLowerCase()
                if (stagedAliasPaths.has(normalizedAlias)) continue
                stagedAliasPaths.add(normalizedAlias)
                await mkdir(path.dirname(aliasPath), { recursive: true })
                await writeFile(aliasPath, depBytes)
              }
            }
            const ambiguousDeps = Array.from(depNameMap.entries()).filter(([, values]) => values.length > 1)
            if (ambiguousDeps.length > 0) {
              const sample = ambiguousDeps
                .slice(0, 12)
                .map(([name, values]) => `${name} => ${values.join(' | ')}`)
                .join('; ')
              const suffix = ambiguousDeps.length > 12 ? '; ...' : ''
              throw new Error(
                `ambiguous dependency names detected (${ambiguousDeps.length}). ` +
                `Upload only one effect dependency folder. ${sample}${suffix}`
              )
            }
            const depSearchRoots = collectDependencySearchRoots(inputRoot, depRelativePaths)

            const useMeshInjector = body.injectMesh !== false
            const outputBase = path.parse(sourceName).name
            const previewOutputName = `${outputBase}.efkwgpk`

            const runNativeConversion = async (
              injectMesh: boolean,
              outputNameForRun: string,
              inputPathForRun = sourcePath
            ) => {
              const outputPathForRun = path.join(outputRoot, outputNameForRun)
              const toolArgs = [
                '--input',
                inputPathForRun,
                '--search-root',
                inputRoot,
              ]
              if (deps.length > 0) {
                // Pack every uploaded dependency file so nested resource chains
                // (model/material side resources) are always available at runtime.
                toolArgs.push('--deps-root', inputRoot)
              }
              for (const depSearchRoot of depSearchRoots) {
                toolArgs.push('--search-root', depSearchRoot)
              }

              if (injectMesh) {
                const meshPath = resolveMeshPath()
                toolArgs.push(
                  '--search-root',
                  path.dirname(meshPath),
                  '--mesh',
                  meshPath,
                  '--name',
                  '__InjectedMeshPreview',
                  '--position',
                  '3.2,0.4,-10',
                  '--scale',
                  '2,2,2',
                  '--spawn-interval',
                  '1',
                  '--life',
                  '100000',
                  '--rotation',
                  '90,0,0',
                )
              }

              if (deps.length === 0) {
                const fallbackRoots = await expandSearchRoots(NATIVE_SEARCH_ROOTS)
                for (const searchRoot of fallbackRoots) {
                  toolArgs.push('--search-root', searchRoot)
                }
              }

              toolArgs.push('--output', outputPathForRun)
              const result = await runDotnetTool(
                injectMesh ? MESH_INJECTOR_CSPROJ : NATIVE_CONVERTER_CSPROJ,
                toolArgs
              )
              return { outputPathForRun, outputNameForRun, result }
            }

            let outputName = previewOutputName
            let outputPath = path.join(outputRoot, outputName)
            let downloadOutputName: string | undefined = undefined
            let downloadOutputPath: string | undefined = undefined
            let meshInjected = false
            let injectWarning = ''
            let depsPacked = deps.length

            if (useMeshInjector) {
              const meshPath = resolveMeshPath()
              const stagedMeshPath = path.join(inputRoot, 'Model', path.basename(meshPath))
              await mkdir(path.dirname(stagedMeshPath), { recursive: true })
              await copyFile(meshPath, stagedMeshPath)
              const outputPathForRun = path.join(outputRoot, previewOutputName)
              const meshArgs = [
                '--input', sourcePath,
                '--output', outputPathForRun,
                '--mesh', stagedMeshPath,
                '--name', '__InjectedMeshPreview',
                '--position', '0,0,0',
                '--scale', '1,1,1',
                '--spawn-interval', '100000',
                '--life', '100000',
                '--rotation', '0,0,0',
                '--deps-root', inputRoot,
                '--search-root', inputRoot,
              ]
              for (const depSearchRoot of depSearchRoots) {
                meshArgs.push('--search-root', depSearchRoot)
              }
              if (deps.length === 0) {
                const fallbackRoots = await expandSearchRoots(NATIVE_SEARCH_ROOTS)
                for (const searchRoot of fallbackRoots) {
                  meshArgs.push('--search-root', searchRoot)
                }
              }

              const injected = await runDotnetTool(MESH_INJECTOR_CSPROJ, meshArgs)
              if (injected.code !== 0) {
                const injectorError = injected.stderr || injected.stdout || `dotnet exited with code ${injected.code}`
                throw new Error(`mesh inject failed: ${injectorError}`)
              }
              outputName = previewOutputName
              outputPath = outputPathForRun
              meshInjected = true
              depsPacked = parseDepsPackedFromToolOutput(injected.stdout) ?? deps.length

              // Also generate the pure download artifact silently.
              const plainDownloadRaw = await runNativeConversion(false, `${outputBase}.efkwg`)
              if (plainDownloadRaw.result.code === 0) {
                 downloadOutputName = plainDownloadRaw.outputNameForRun
                 downloadOutputPath = plainDownloadRaw.outputPathForRun
              }

            } else {
              const plain = await runNativeConversion(false, previewOutputName)
              if (plain.result.code !== 0) {
                throw new Error(plain.result.stderr || plain.result.stdout || `dotnet exited with code ${plain.result.code}`)
              }
              outputName = plain.outputNameForRun
              outputPath = plain.outputPathForRun
              depsPacked = parseDepsPackedFromToolOutput(plain.result.stdout) ?? deps.length
            }

            const outputBytes = await readFile(outputPath)
            const entries = outputBytes.length >= 24
              ? new DataView(outputBytes.buffer, outputBytes.byteOffset, outputBytes.byteLength).getUint32(20, true)
              : 0

            let downloadBytesBase64: string | undefined = undefined
            if (downloadOutputPath) {
               try {
                   const dlBytes = await readFile(downloadOutputPath)
                   downloadBytesBase64 = encodeBase64(dlBytes)
               } catch (e) {
                   // Ignore download bytes read errors
               }
            }

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
              outputName,
              bytesBase64: encodeBase64(outputBytes),
              downloadOutputName,
              downloadBytesBase64,
              entries,
              depsPacked,
              meshInjected,
              injectWarning,
              backendRevision: NATIVE_BACKEND_REVISION,
            }))
          } catch (error) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }))
          } finally {
            if (tempDir) {
              try {
                await rm(tempDir, { recursive: true, force: true })
              } catch {
                // Ignore cleanup failures in dev server.
              }
            }
          }
          return
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
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), effekseerRuntimePlugin()],
  assetsInclude: ['**/*.efkwgpk'],
  resolve: {
    alias: {
      'three-effekseer': fileURLToPath(
        new URL('./addons/three-effekseer/index.ts', import.meta.url)
      ),
      'three/webgpu': fileURLToPath(
        new URL('./node_modules/three/build/three.webgpu.js', import.meta.url)
      ),
    },
  },
  server: {
    fs: {
      allow: [EFFEKSEER_RUNTIME_DIR],
    },
  },
  build: {
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        vanilla: fileURLToPath(new URL('./vanilla/index.html', import.meta.url)),
        canvasOnly: fileURLToPath(new URL('./canvas-only/index.html', import.meta.url)),
      },
    },
  },
})
