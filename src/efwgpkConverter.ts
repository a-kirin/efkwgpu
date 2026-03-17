export type ConverterInputFile = {
  name: string
  relativePath: string
  bytes: Uint8Array
}

export type ConvertedPackage = {
  bytes: Uint8Array
  outputName: string
  downloadBytes?: Uint8Array
  downloadOutputName?: string
  mainEffectPath: string
  entries: number
  depsPacked: number
  profile: 'package' | 'converted-package'
  meshInjected?: boolean
  injectWarning?: string
  backendRevision?: string
}

type FflateApi = {
  zlibSync?: (data: Uint8Array, options?: { level?: number }) => Uint8Array
  unzipSync?: (data: Uint8Array) => Record<string, Uint8Array | ArrayBuffer>
}

const MAGIC_EFKE = 'EFKE'
const MAGIC_SKFE = 'SKFE'
const MAGIC_EFWG = 'EFWG'
const MAGIC_EFWGPK = 'EFWGPKG1'

const EFWG_VERSION = 1
const EFWG_FLAG_AES128_CTR = 1
const NONCE_SIZE = 16

const EFWGPK_HEADER_SIZE = 64
const EFWGPK_ENTRY_SIZE = 48
const EFWGPK_GLOBAL_PACKAGE = 1 << 1
const EFWGPK_ENTRY_DEFLATE = 1 << 0
const EFWGPK_META_MAIN = '__efwgpk__/main_effect_path.txt'

const AES_KEY = new Uint8Array([
  0x45, 0x66, 0x6b, 0x57, 0x67, 0x2e, 0x57, 0x65,
  0x62, 0x47, 0x50, 0x55, 0x2e, 0x43, 0x54, 0x52,
])

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let j = 0; j < 8; j++) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    }
    table[i] = value >>> 0
  }
  return table
})()

const getFflate = (): FflateApi | null => {
  const candidate = (globalThis as typeof globalThis & { fflate?: FflateApi }).fflate
  return candidate ?? null
}

const getMagic = (bytes: Uint8Array, length = 4): string => {
  if (bytes.length < length) return ''
  return String.fromCharCode(...bytes.subarray(0, length))
}

const getFileExtension = (name: string): string => {
  const value = String(name || '').toLowerCase()
  const dot = value.lastIndexOf('.')
  return dot >= 0 ? value.slice(dot) : ''
}

const replaceExtension = (path: string, nextExt: string): string => {
  const normalizedExt = nextExt.startsWith('.') ? nextExt : `.${nextExt}`
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const lastDot = path.lastIndexOf('.')
  if (lastDot > lastSlash) {
    return `${path.slice(0, lastDot)}${normalizedExt}`
  }
  return `${path}${normalizedExt}`
}

const normalizePathUtf8 = (path: string): string => {
  if (!path) throw new Error('empty path')

  const text = String(path).replace(/\\/g, '/')
  const segments: string[] = []
  for (const raw of text.split('/')) {
    if (!raw || raw === '.') continue
    if (raw === '..') throw new Error(`parent traversal is not allowed: ${path}`)
    segments.push(raw.toLowerCase())
  }

  if (segments.length === 0) {
    throw new Error(`path became empty after normalization: ${path}`)
  }

  return segments.join('/')
}

const buildAliases = (path: string): string[] => {
  if (!path) return []

  const normalized = String(path).replace(/\\/g, '/')
  const variants = [normalized]

  let withoutDot = normalized
  while (withoutDot.startsWith('./')) {
    withoutDot = withoutDot.slice(2)
  }
  if (withoutDot && withoutDot !== normalized) variants.push(withoutDot)

  const filename = normalized.split('/').pop() || ''
  if (filename && filename !== normalized) variants.push(filename)

  const addFolderHints = (value: string) => {
    if (!value || value.includes('/')) return
    const lower = value.toLowerCase()
    if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.dds') || lower.endsWith('.tga') || lower.endsWith('.bmp')) {
      variants.push(`Texture/${value}`)
      variants.push(`texture/${value}`)
    }
    if (lower.endsWith('.efkmodel') || lower.endsWith('.mqo')) {
      variants.push(`Model/${value}`)
      variants.push(`model/${value}`)
      variants.push(`mqo/${value}`)
    }
    if (lower.endsWith('.wav') || lower.endsWith('.ogg') || lower.endsWith('.mp3')) {
      variants.push(`Sound/${value}`)
      variants.push(`sound/${value}`)
    }
  }

  addFolderHints(filename)

  const segments: string[] = []
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0) segments.pop()
      continue
    }
    segments.push(segment)
  }
  for (let i = 0; i < segments.length; i++) {
    variants.push(segments.slice(i).join('/'))
  }

  const unique: string[] = []
  const seen = new Set<string>()
  for (const variant of variants) {
    try {
      const normalizedVariant = normalizePathUtf8(variant)
      if (!seen.has(normalizedVariant)) {
        seen.add(normalizedVariant)
        unique.push(normalizedVariant)
      }
    } catch {
      // Ignore invalid alias candidates.
    }
  }

  return unique
}

const concatUint8Arrays = (chunks: Uint8Array[], totalLength = -1): Uint8Array => {
  let size = totalLength
  if (size < 0) {
    size = 0
    for (const chunk of chunks) size += chunk.length
  }

  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    const index = (crc ^ bytes[i]) & 0xff
    crc = (crc >>> 8) ^ crcTable[index]
  }
  return (~crc) >>> 0
}

const fnv1a64 = (bytes: Uint8Array): bigint => {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i])
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash
}

const writeU64LE = (view: DataView, offset: number, value: bigint) => {
  const normalized = BigInt.asUintN(64, value)
  view.setUint32(offset, Number(normalized & 0xffffffffn), true)
  view.setUint32(offset + 4, Number((normalized >> 32n) & 0xffffffffn), true)
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const readChunks = (bytes: Uint8Array, startOffset: number) => {
  const chunks: Array<{ fourcc: string; payload: Uint8Array }> = []
  let offset = startOffset

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new Error('truncated chunk header')
    }

    const fourcc = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    offset += 4

    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true)
    offset += 4

    if (offset + size > bytes.length) {
      throw new Error(`truncated chunk payload: ${fourcc}`)
    }

    chunks.push({
      fourcc,
      payload: bytes.slice(offset, offset + size),
    })
    offset += size
  }

  return chunks
}

const buildChunkBlob = (chunks: Array<{ fourcc: string; payload: Uint8Array }>): Uint8Array => {
  let total = 0
  for (const chunk of chunks) {
    total += 8 + chunk.payload.length
  }

  const output = new Uint8Array(total)
  const view = new DataView(output.buffer)
  let offset = 0

  for (const chunk of chunks) {
    for (let i = 0; i < 4; i++) {
      output[offset + i] = chunk.fourcc.charCodeAt(i)
    }
    offset += 4
    view.setUint32(offset, chunk.payload.length, true)
    offset += 4
    output.set(chunk.payload, offset)
    offset += chunk.payload.length
  }

  return output
}

const renameChunksForEfwg = (chunks: Array<{ fourcc: string; payload: Uint8Array }>) => {
  let foundRuntime = false
  const remapped: Array<{ fourcc: string; payload: Uint8Array }> = []

  for (const chunk of chunks) {
    if (chunk.fourcc === 'BIN_') {
      remapped.push({ fourcc: 'WGDT', payload: chunk.payload })
      foundRuntime = true
      continue
    }
    if (chunk.fourcc === 'EDIT') {
      remapped.push({ fourcc: 'XML_', payload: chunk.payload })
      continue
    }
    remapped.push(chunk)
  }

  if (!foundRuntime) {
    throw new Error('BIN_ chunk not found in the efkefc source')
  }

  return remapped
}

const buildEfwgPayload = (inputBytes: Uint8Array): Uint8Array => {
  const magic = getMagic(inputBytes, 4)
  if (magic === MAGIC_SKFE) {
    return buildChunkBlob([{ fourcc: 'WGDT', payload: inputBytes }])
  }
  if (magic === MAGIC_EFKE) {
    return buildChunkBlob(renameChunksForEfwg(readChunks(inputBytes, 8)))
  }
  throw new Error(`unsupported efkwg source: magic=${magic}`)
}

const encryptCtr = async (plain: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> => {
  const counter = new Uint8Array(nonce.byteLength)
  counter.set(nonce)
  const payload = new Uint8Array(plain.byteLength)
  payload.set(plain)

  const key = await crypto.subtle.importKey(
    'raw',
    AES_KEY,
    { name: 'AES-CTR' },
    false,
    ['encrypt']
  )

  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-CTR',
      counter,
      length: 128,
    },
    key,
    payload
  )

  return new Uint8Array(encrypted)
}

const buildEfwgFile = async (inputBytes: Uint8Array): Promise<Uint8Array> => {
  const innerChunkBlob = buildEfwgPayload(inputBytes)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_SIZE))
  const encryptedBlob = await encryptCtr(innerChunkBlob, nonce)

  const output = new Uint8Array(4 + 4 + 4 + 4 + 4 + NONCE_SIZE + encryptedBlob.length)
  const view = new DataView(output.buffer)
  let offset = 0

  for (let i = 0; i < 4; i++) {
    output[offset + i] = MAGIC_EFWG.charCodeAt(i)
  }
  offset += 4
  view.setInt32(offset, EFWG_VERSION, true)
  offset += 4
  view.setUint32(offset, EFWG_FLAG_AES128_CTR, true)
  offset += 4
  view.setInt32(offset, NONCE_SIZE, true)
  offset += 4
  view.setInt32(offset, encryptedBlob.length, true)
  offset += 4
  output.set(nonce, offset)
  offset += NONCE_SIZE
  output.set(encryptedBlob, offset)

  return output
}

const compressPackagePayload = (payload: Uint8Array) => {
  const fflate = getFflate()
  if (!(payload instanceof Uint8Array) || payload.length === 0 || !fflate?.zlibSync) {
    return { bytes: payload, flags: 0, rawSize: payload.length }
  }

  try {
    const compressed = fflate.zlibSync(payload, { level: 9 })
    if (!(compressed instanceof Uint8Array) || compressed.length >= payload.length) {
      return { bytes: payload, flags: 0, rawSize: payload.length }
    }
    return { bytes: compressed, flags: EFWGPK_ENTRY_DEFLATE, rawSize: payload.length }
  } catch {
    return { bytes: payload, flags: 0, rawSize: payload.length }
  }
}

const buildEfwgpkBlob = (entries: Array<{ path: string; payload: Uint8Array }>): Uint8Array => {
  if (entries.length === 0) {
    throw new Error('entries is empty')
  }

  const entryCount = entries.length
  const entriesOffset = EFWGPK_HEADER_SIZE
  const entriesRegionSize = entryCount * EFWGPK_ENTRY_SIZE
  const stringPoolOffset = entriesOffset + entriesRegionSize

  const pathMeta = new Map<string, { offset: number; length: number }>()
  const stringParts: Uint8Array[] = []
  let stringPoolSize = 0
  for (const entry of entries) {
    const pathBytes = textEncoder.encode(entry.path)
    pathMeta.set(entry.path, {
      offset: stringPoolOffset + stringPoolSize,
      length: pathBytes.length,
    })
    stringParts.push(pathBytes)
    stringPoolSize += pathBytes.length
  }

  const payloadOffset = stringPoolOffset + stringPoolSize
  const entryRegion = new Uint8Array(entriesRegionSize)
  const entryView = new DataView(entryRegion.buffer)
  const payloadParts: Uint8Array[] = []
  const payloadBuckets = new Map<string, Array<{
    rawPayload: Uint8Array
    payload: Uint8Array
    offset: number
    packedSize: number
    packedCrc: number
    rawSize: number
    rawCrc: number
    flags: number
  }>>()
  let payloadSize = 0
  let payloadWriteOffset = payloadOffset

  for (let i = 0; i < entryCount; i++) {
    const entry = entries[i]
    const rawPayload = entry.payload
    const meta = pathMeta.get(entry.path)
    if (!meta) {
      throw new Error(`missing path metadata for ${entry.path}`)
    }

    const rawSize = rawPayload.length
    const rawCrc = crc32(rawPayload)
    const payloadKey = `${rawSize}:${rawCrc}`
    const bucket = payloadBuckets.get(payloadKey) || []
    let payloadRecord = bucket.find((candidate) => bytesEqual(candidate.rawPayload, rawPayload)) || null

    if (!payloadRecord) {
      const packed = compressPackagePayload(rawPayload)
      payloadRecord = {
        rawPayload,
        payload: packed.bytes,
        offset: payloadWriteOffset,
        packedSize: packed.bytes.length,
        packedCrc: crc32(packed.bytes),
        rawSize: packed.rawSize,
        rawCrc,
        flags: packed.flags,
      }
      bucket.push(payloadRecord)
      payloadBuckets.set(payloadKey, bucket)
      payloadParts.push(packed.bytes)
      payloadSize += packed.bytes.length
      payloadWriteOffset += packed.bytes.length
    }

    const base = i * EFWGPK_ENTRY_SIZE
    writeU64LE(entryView, base + 0, fnv1a64(textEncoder.encode(entry.path)))
    entryView.setUint32(base + 8, meta.offset >>> 0, true)
    entryView.setUint32(base + 12, meta.length >>> 0, true)
    entryView.setUint32(base + 16, payloadRecord.flags >>> 0, true)
    entryView.setUint32(base + 20, payloadRecord.offset >>> 0, true)
    entryView.setUint32(base + 24, payloadRecord.packedSize >>> 0, true)
    entryView.setUint32(base + 28, payloadRecord.rawSize >>> 0, true)
    entryView.setUint32(base + 32, payloadRecord.packedCrc >>> 0, true)
    entryView.setUint32(base + 36, payloadRecord.rawCrc >>> 0, true)
    writeU64LE(entryView, base + 40, 0n)
  }

  const stringBlob = concatUint8Arrays(stringParts, stringPoolSize)
  const payloadBlob = concatUint8Arrays(payloadParts, payloadSize)

  const header = new Uint8Array(EFWGPK_HEADER_SIZE)
  const headerView = new DataView(header.buffer)
  header.set(textEncoder.encode(MAGIC_EFWGPK), 0)
  headerView.setUint32(8, EFWGPK_HEADER_SIZE, true)
  headerView.setUint32(12, EFWGPK_GLOBAL_PACKAGE >>> 0, true)
  headerView.setUint32(16, 0, true)
  headerView.setUint32(20, entryCount >>> 0, true)
  headerView.setUint32(24, EFWGPK_ENTRY_SIZE, true)
  headerView.setUint32(28, entriesOffset >>> 0, true)
  headerView.setUint32(32, stringPoolOffset >>> 0, true)
  headerView.setUint32(36, stringPoolSize >>> 0, true)
  headerView.setUint32(40, payloadOffset >>> 0, true)
  headerView.setUint32(44, payloadSize >>> 0, true)
  headerView.setUint32(48, 0, true)
  headerView.setUint32(52, 0, true)
  writeU64LE(headerView, 56, 0n)

  const tocCrc = crc32(concatUint8Arrays([header, entryRegion, stringBlob]))
  const payloadCrc = crc32(payloadBlob)
  headerView.setUint32(48, tocCrc >>> 0, true)
  headerView.setUint32(52, payloadCrc >>> 0, true)

  return concatUint8Arrays([header, entryRegion, stringBlob, payloadBlob])
}

const addEntryWithDedupe = (
  pathToPayload: Map<string, Uint8Array>,
  aliasPath: string,
  payload: Uint8Array
) => {
  const normalized = normalizePathUtf8(aliasPath)
  const previous = pathToPayload.get(normalized)
  if (!previous) {
    pathToPayload.set(normalized, payload)
    return
  }
  if (!bytesEqual(previous, payload)) {
    throw new Error(`path collision with different payload: ${normalized}`)
  }
}

const buildPackageFromEfkefc = async (
  inputName: string,
  inputBytes: Uint8Array,
  extraFiles: ConverterInputFile[]
): Promise<ConvertedPackage> => {
  const pathToPayload = new Map<string, Uint8Array>()
  const mainEffectPath = normalizePathUtf8(replaceExtension(inputName || 'effect.efkefc', '.efkwg'))
  const mainEffectBytes = await buildEfwgFile(inputBytes)
  addEntryWithDedupe(pathToPayload, mainEffectPath, mainEffectBytes)
  addEntryWithDedupe(pathToPayload, EFWGPK_META_MAIN, textEncoder.encode(mainEffectPath))

  for (const dep of extraFiles) {
    if (!(dep.bytes instanceof Uint8Array) || dep.bytes.length === 0) {
      continue
    }

    const seedAliases = []
    if (dep.relativePath) seedAliases.push(dep.relativePath)
    if (dep.name) seedAliases.push(dep.name)

    const seen = new Set<string>()
    for (const seed of seedAliases) {
      for (const alias of buildAliases(seed)) {
        if (seen.has(alias)) continue
        seen.add(alias)
        addEntryWithDedupe(pathToPayload, alias, dep.bytes)
      }
    }
  }

  const entries = [...pathToPayload.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, payload]) => ({ path, payload }))

  return {
    bytes: buildEfwgpkBlob(entries),
    outputName: replaceExtension(inputName || 'effect.efkefc', '.efkwgpk'),
    mainEffectPath,
    entries: entries.length,
    depsPacked: extraFiles.length,
    profile: 'package',
  }
}

const buildPackageFromEfkpkg = async (
  inputName: string,
  inputBytes: Uint8Array
): Promise<ConvertedPackage> => {
  const fflate = getFflate()
  if (!fflate?.unzipSync) {
    throw new Error('fflate.unzipSync is not available')
  }

  const zipMap = fflate.unzipSync(inputBytes)
  const zipEntries: Record<string, Uint8Array> = {}
  for (const [key, value] of Object.entries(zipMap)) {
    zipEntries[String(key)] = value instanceof Uint8Array ? value : new Uint8Array(value)
  }

  let metafileKey = ''
  for (const key of Object.keys(zipEntries)) {
    if (key.toLowerCase() === 'metafile.json') {
      metafileKey = key
      break
    }
  }
  if (!metafileKey) {
    throw new Error('metafile.json not found in efkpkg')
  }

  let metaJson: { files?: Record<string, unknown> } | null = null
  try {
    metaJson = JSON.parse(textDecoder.decode(zipEntries[metafileKey]).replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`failed to parse metafile.json: ${error instanceof Error ? error.message : String(error)}`)
  }

  const files = metaJson?.files
  if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
    throw new Error('metafile.json has no valid files map')
  }

  const effectKeys: string[] = []
  for (const [key, info] of Object.entries(files)) {
    if (info && typeof info === 'object' && 'type' in info && (info as { type?: unknown }).type === 'Effect') {
      effectKeys.push(String(key))
    }
  }
  if (effectKeys.length === 0) {
    throw new Error('no Effect entry in metafile.json')
  }
  if (effectKeys.length !== 1) {
    throw new Error('only single-effect efkpkg is supported in this converter')
  }

  const mainEffectKey = effectKeys[0]
  const mainEffectInfo = files[mainEffectKey] && typeof files[mainEffectKey] === 'object'
    ? files[mainEffectKey] as { relative_path?: string }
    : {}
  const mainEffectPayload = zipEntries[mainEffectKey]
  if (!(mainEffectPayload instanceof Uint8Array) || mainEffectPayload.length === 0) {
    throw new Error(`main effect payload not found: ${mainEffectKey}`)
  }

  const pathToPayload = new Map<string, Uint8Array>()
  const mainEffectRelativePath = String(mainEffectInfo.relative_path || mainEffectKey)
  const mainEffectPath = normalizePathUtf8(replaceExtension(mainEffectRelativePath, '.efkwg'))
  const mainEffectBytes = await buildEfwgFile(mainEffectPayload)
  addEntryWithDedupe(pathToPayload, mainEffectPath, mainEffectBytes)
  addEntryWithDedupe(pathToPayload, EFWGPK_META_MAIN, textEncoder.encode(mainEffectPath))

  const consumedZipKeys = new Set<string>([metafileKey, mainEffectKey])

  for (const [keyRaw, infoRaw] of Object.entries(files)) {
    const key = String(keyRaw)
    if (key === mainEffectKey) continue

    const info = (infoRaw && typeof infoRaw === 'object') ? infoRaw as {
      type?: string
      dependencies?: unknown[]
      relative_path?: string
    } : {}
    const fileType = String(info.type || '')
    if (fileType === 'Effect') {
      throw new Error('nested Effect entries are not supported in this converter')
    }

    const dependencies = Array.isArray(info.dependencies) ? info.dependencies.map((dependency) => String(dependency)) : []
    const relativePath = info.relative_path != null ? String(info.relative_path) : ''

    let payloadKey = key
    if ((fileType === 'Curve' || fileType === 'Model') && dependencies.length > 0) {
      const candidate = dependencies[0]
      if (Object.prototype.hasOwnProperty.call(zipEntries, candidate)) {
        payloadKey = candidate
      }
    }

    consumedZipKeys.add(key)
    consumedZipKeys.add(payloadKey)

    const payload = zipEntries[payloadKey] || zipEntries[key]
    if (!(payload instanceof Uint8Array) || payload.length === 0) {
      continue
    }

    const aliasSeeds = []
    if (relativePath) aliasSeeds.push(relativePath)
    aliasSeeds.push(key)
    if (fileType === 'Curve') aliasSeeds.push(`${key}.efkcurve`)

    const seen = new Set<string>()
    for (const seed of aliasSeeds) {
      for (const alias of buildAliases(seed)) {
        if (seen.has(alias)) continue
        seen.add(alias)
        addEntryWithDedupe(pathToPayload, alias, payload)
      }
    }
  }

  for (const [zipKey, payload] of Object.entries(zipEntries)) {
    if (consumedZipKeys.has(zipKey) || !(payload instanceof Uint8Array) || payload.length === 0) {
      continue
    }

    const seen = new Set<string>()
    for (const alias of buildAliases(zipKey)) {
      if (seen.has(alias)) continue
      seen.add(alias)
      addEntryWithDedupe(pathToPayload, alias, payload)
    }
  }

  const entries = [...pathToPayload.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, payload]) => ({ path, payload }))

  return {
    bytes: buildEfwgpkBlob(entries),
    outputName: replaceExtension(inputName || 'effect.efkpkg', '.efkwgpk'),
    mainEffectPath,
    entries: entries.length,
    depsPacked: 0,
    profile: 'package',
  }
}

export const convertToEfwgpk = async (
  inputName: string,
  inputBuffer: ArrayBuffer | Uint8Array,
  extraFiles: ConverterInputFile[]
): Promise<ConvertedPackage> => {
  const inputBytes = inputBuffer instanceof Uint8Array ? inputBuffer : new Uint8Array(inputBuffer)
  const ext = getFileExtension(inputName)
  const magic4 = getMagic(inputBytes, 4)
  const magic8 = getMagic(inputBytes, 8)

  if (ext === '.efkwgpk' || magic8 === MAGIC_EFWGPK) {
    return {
      bytes: inputBytes,
      outputName: replaceExtension(inputName || 'converted.efkwgpk', '.efkwgpk'),
      mainEffectPath: '',
      entries: 0,
      depsPacked: 0,
      profile: 'converted-package',
    }
  }

  if (ext === '.efkpkg' || magic4 === 'PK\u0003\u0004') {
    return buildPackageFromEfkpkg(inputName, inputBytes)
  }

  if (ext === '.efkefc' || magic4 === MAGIC_EFKE || magic4 === MAGIC_SKFE) {
    return buildPackageFromEfkefc(inputName, inputBytes, extraFiles)
  }

  throw new Error('input must be .efkefc, .efkpkg, or .efkwgpk')
}
