import { onRequest } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

type NativeConvertRequest = {
  sourceName?: string
  sourceBase64?: string
  injectMesh?: boolean
  deps?: Array<{
    name?: string
    relativePath?: string
    bytesBase64?: string
  }>
}

const TOOL_TFM = 'net8.0'
const DOTNET_CMD = process.env.DOTNET_CMD || 'dotnet'

// Default for local emulator in this repository layout.
const EFFEKSEER_ROOT_DIR =
  process.env.EFFEKSEER_ROOT_DIR ||
  path.resolve(__dirname, '..', '..', '..', '..', '..')

const DEFAULT_NATIVE_CONVERTER_CSPROJ = path.join(
  EFFEKSEER_ROOT_DIR,
  'Dev',
  'Editor',
  'EffekseerNativeConverter',
  'EffekseerNativeConverter.csproj'
)

const DEFAULT_MESH_INJECTOR_CSPROJ = path.join(
  EFFEKSEER_ROOT_DIR,
  'Dev',
  'Editor',
  'EffekseerMeshInjector',
  'EffekseerMeshInjector.csproj'
)

const DEFAULT_NATIVE_MESH_PATH = path.join(
  EFFEKSEER_ROOT_DIR,
  'Examples',
  'WebGPU',
  'react-vite-ts',
  'public',
  'fx',
  'preview-text.efkmodel'
)

const NATIVE_SEARCH_ROOTS = [
  path.join(EFFEKSEER_ROOT_DIR, 'Examples', 'Resources'),
  path.join(EFFEKSEER_ROOT_DIR, 'Examples', 'WebGPU', 'Sample'),
]

const NATIVE_CONVERTER_CSPROJ = process.env.NATIVE_CONVERTER_CSPROJ || DEFAULT_NATIVE_CONVERTER_CSPROJ
const MESH_INJECTOR_CSPROJ = process.env.MESH_INJECTOR_CSPROJ || DEFAULT_MESH_INJECTOR_CSPROJ
const NATIVE_CONVERTER_DLL = process.env.NATIVE_CONVERTER_DLL || ''
const MESH_INJECTOR_DLL = process.env.MESH_INJECTOR_DLL || ''
const MESH_PATH = process.env.NATIVE_MESH_PATH || DEFAULT_NATIVE_MESH_PATH
const NATIVE_BACKEND_REVISION = 'native-rev-2026-03-16-tmpwg-local+depsroot'

const pendingToolBuilds = new Map<string, Promise<string>>()
const builtToolProjects = new Set<string>()

const parseRequestBody = (body: unknown): NativeConvertRequest => {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    return body as NativeConvertRequest
  }
  if (typeof body === 'string') {
    return JSON.parse(body) as NativeConvertRequest
  }
  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString('utf8')) as NativeConvertRequest
  }
  throw new Error('invalid JSON body')
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

const resolveMeshPath = (): string => {
  const candidate = path.resolve(MESH_PATH)
  if (!existsSync(candidate)) {
    throw new Error(`mesh file not found: ${candidate}`)
  }
  return candidate
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

const getToolDllPathFromProject = (projectPath: string): string => {
  const projectDir = path.dirname(projectPath)
  const projectName = path.basename(projectPath, '.csproj')
  const debugDll = path.join(projectDir, 'bin', 'Debug', TOOL_TFM, `${projectName}.dll`)
  if (existsSync(debugDll)) {
    return debugDll
  }
  return path.join(projectDir, 'bin', 'Release', TOOL_TFM, `${projectName}.dll`)
}

const ensureToolDll = async (projectPath: string): Promise<string> => {
  const existingDll = getToolDllPathFromProject(projectPath)
  if (builtToolProjects.has(projectPath) && existsSync(existingDll)) {
    return existingDll
  }

  let pendingBuild = pendingToolBuilds.get(projectPath)
  if (!pendingBuild) {
    pendingBuild = (async () => {
      const buildResult = await runCommand(
        DOTNET_CMD,
        ['build', projectPath, '-c', 'Debug', '-nologo'],
        EFFEKSEER_ROOT_DIR
      )
      if (buildResult.code !== 0) {
        throw new Error(buildResult.stderr || buildResult.stdout || `dotnet build failed for ${projectPath}`)
      }

      const builtDll = getToolDllPathFromProject(projectPath)
      if (!existsSync(builtDll)) {
        throw new Error(`converter DLL not found after build: ${builtDll}`)
      }
      builtToolProjects.add(projectPath)
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

const resolveToolDll = async (preferredDll: string, fallbackCsproj: string): Promise<string> => {
  if (preferredDll) {
    const absDll = path.resolve(preferredDll)
    if (existsSync(absDll)) {
      return absDll
    }
    throw new Error(`configured DLL not found: ${absDll}`)
  }

  if (!existsSync(fallbackCsproj)) {
    throw new Error(
      `converter project not found: ${fallbackCsproj}. Set *_DLL env vars for deployed Cloud Functions.`
    )
  }

  return ensureToolDll(fallbackCsproj)
}

const runDotnetDll = async (
  dllPath: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
  return runCommand(DOTNET_CMD, [dllPath, ...args], EFFEKSEER_ROOT_DIR)
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

export const nativeConvert = onRequest(
  {
    region: process.env.FUNCTION_REGION || 'us-central1',
    timeoutSeconds: 540,
    memory: '2GiB',
    cors: true,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' })
      return
    }

    let tempDir = ''
    try {
      const body = parseRequestBody(req.body)
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
      const outputName = `${outputBase}.preview.efkwgpk`
      const outputPath = path.join(outputRoot, outputName)

      const toolArgs = ['--input', sourcePath, '--search-root', inputRoot]
      if (deps.length > 0) {
        // Pack every uploaded dependency file so nested resource chains
        // (model/material side resources) are always available at runtime.
        toolArgs.push('--deps-root', inputRoot)
      }
      for (const depSearchRoot of depSearchRoots) {
        toolArgs.push('--search-root', depSearchRoot)
      }
      let meshInjected = false
      let depsPacked = deps.length
      if (deps.length === 0) {
        const fallbackRoots = await expandSearchRoots(NATIVE_SEARCH_ROOTS)
        for (const searchRoot of fallbackRoots) {
          toolArgs.push('--search-root', searchRoot)
        }
      }

      if (useMeshInjector) {
        const meshInjectorDll = await resolveToolDll(MESH_INJECTOR_DLL, MESH_INJECTOR_CSPROJ)
        const meshPath = resolveMeshPath()
        toolArgs.push(
          '--search-root',
          path.dirname(meshPath),
          '--mesh',
          meshPath,
          '--name',
          '__InjectedMeshPreview',
          '--position',
          '-2,0.4,-10',
          '--scale',
          '2,2,2',
          '--spawn-interval',
          '1',
          '--life',
          '100000',
          '--rotation',
          '90,0,0',
          '--output',
          outputPath
        )
        const injected = await runDotnetDll(meshInjectorDll, toolArgs)
        if (injected.code !== 0) {
          throw new Error(injected.stderr || injected.stdout || `dotnet exited with code ${injected.code}`)
        }
        meshInjected = true
        depsPacked = parseDepsPackedFromToolOutput(injected.stdout) ?? deps.length
      } else {
        const nativeConverterDll = await resolveToolDll(NATIVE_CONVERTER_DLL, NATIVE_CONVERTER_CSPROJ)
        toolArgs.push('--output', outputPath)
        const plain = await runDotnetDll(nativeConverterDll, toolArgs)
        if (plain.code !== 0) {
          throw new Error(plain.stderr || plain.stdout || `dotnet exited with code ${plain.code}`)
        }
        depsPacked = parseDepsPackedFromToolOutput(plain.stdout) ?? deps.length
      }

      const outputBytes = await readFile(outputPath)
      const entries = outputBytes.length >= 24
        ? new DataView(outputBytes.buffer, outputBytes.byteOffset, outputBytes.byteLength).getUint32(20, true)
        : 0

      res.status(200).json({
        outputName,
        bytesBase64: encodeBase64(outputBytes),
        entries,
        depsPacked,
        meshInjected,
        injectWarning: '',
        backendRevision: NATIVE_BACKEND_REVISION,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('nativeConvert failed', message)
      res.status(500).json({ error: message })
    } finally {
      if (tempDir) {
        try {
          await rm(tempDir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  }
)
