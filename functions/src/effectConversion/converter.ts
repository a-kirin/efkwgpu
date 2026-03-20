import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { unzlibSync, unzipSync, zlibSync } from 'fflate'

export type ConverterInputFile = {
  name: string
  relativePath: string
  bytes: Uint8Array
}

export type ConvertedPackage = {
  bytes: Uint8Array
  outputName: string
  mainEffectPath: string
  entries: number
  depsPacked: number
  profile: 'effect' | 'package'
  backendRevision: 'v3'
}

const MAGIC_EFKE = 'EFKE'
const MAGIC_SKFE = 'SKFE'
const MAGIC_EFWG = 'EFWG'
const MAGIC_EFWGPK = 'EFWGPKG2'

const EFWG_VERSION = 2
const EFWG_FLAG_AES128_CTR = 1
const NONCE_SIZE = 16

const EFWGPK_HEADER_SIZE = 80
const EFWGPK_ENTRY_SIZE = 48
const EFWGPK_FORMAT_REVISION = 3
const EFWGPK_GLOBAL_PACKAGE = 1 << 1
const EFWGPK_GLOBAL_AES128_CTR = 1 << 2
const EFWGPK_ENTRY_DEFLATE = 1 << 0
const EFWGPK_META_MAIN = '__efwgpk__/main_effect_path.txt'
const EDIT_CHUNK_FOURCC = 'EDIT'

const BASIS_BYTES = new Uint8Array([
  0x45, 0x66, 0x6b, 0x57, 0x67, 0x2e, 0x57, 0x65,
  0x62, 0x47, 0x50, 0x55, 0x2e, 0x43, 0x54, 0x52,
])

const RESOURCE_PATH_REGEX = /([^\u0000\r\n"'<>|]+?\.(?:png|jpg|jpeg|dds|tga|bmp|efkmodel|mqo|efkmat|efkmatd|wav|ogg|mp3|efkcurve))/gi
const HASHED_RESOURCE_NAME_REGEX = /\b[0-9a-fA-F]{32}-[0-9a-fA-F]{8}\b/g

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

const computeEffekseerHashName = (bytes: Uint8Array): string => {
  const hash = createHash('md5').update(bytes).digest('hex').toUpperCase()
  const size = bytes.length.toString(16).toUpperCase().padStart(8, '0')
  return `${hash}-${size}`
}

const decodeUtf16Le = (bytes: Uint8Array): string => {
  if (bytes.length < 2) return ''
  try {
    return Buffer.from(bytes).toString('utf16le')
  } catch {
    return ''
  }
}

const collectRegexMatches = (text: string, regex: RegExp, normalize: (value: string) => string | null, out: Set<string>) => {
  regex.lastIndex = 0
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(text)) !== null) {
    const rawValue = String(match[1] || match[0] || '').trim().replace(/^['"]+|['"]+$/g, '')
    if (!rawValue) continue
    const normalized = normalize(rawValue)
    if (normalized) out.add(normalized)
  }
}

const extractBinaryDependencyRefs = (bytes: Uint8Array): string[] => {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return []
  }

  const refs = new Set<string>()
  const texts = [
    Buffer.from(bytes).toString('latin1'),
    textDecoder.decode(bytes),
    decodeUtf16Le(bytes),
  ]

  for (const text of texts) {
    if (!text) continue
    collectRegexMatches(text, RESOURCE_PATH_REGEX, (value) => {
      try {
        return normalizePathUtf8(value)
      } catch {
        return null
      }
    }, refs)
    collectRegexMatches(text, HASHED_RESOURCE_NAME_REGEX, (value) => {
      try {
        return normalizePathUtf8(value)
      } catch {
        return null
      }
    }, refs)
  }

  return [...refs].sort((a, b) => a.localeCompare(b))
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

const encryptCtr = (plain: Uint8Array, nonce: Uint8Array): Uint8Array => {
  const cipher = createCipheriv('aes-128-ctr', Buffer.from(BASIS_BYTES), Buffer.from(nonce))
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plain)),
    cipher.final(),
  ])
  return new Uint8Array(encrypted)
}

const buildEfwgFile = (inputBytes: Uint8Array): Uint8Array => {
  const innerChunkBlob = buildEfwgPayload(inputBytes)
  const nonce = randomBytes(NONCE_SIZE)
  const encryptedBlob = encryptCtr(innerChunkBlob, nonce)

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
  if (!(payload instanceof Uint8Array) || payload.length === 0) {
    return { bytes: payload, flags: 0, rawSize: payload.length }
  }

  try {
    const compressed = zlibSync(payload, { level: 9 })
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
      payloadWriteOffset += packed.bytes.length
      payloadSize += packed.bytes.length
      payloadParts.push(packed.bytes)
      bucket.push(payloadRecord)
      payloadBuckets.set(payloadKey, bucket)
    }

    const entryOffset = i * EFWGPK_ENTRY_SIZE
    const pathBytes = textEncoder.encode(entry.path)
    writeU64LE(entryView, entryOffset, fnv1a64(pathBytes))
    entryView.setUint32(entryOffset + 8, meta.offset >>> 0, true)
    entryView.setUint32(entryOffset + 12, meta.length >>> 0, true)
    entryView.setUint32(entryOffset + 16, payloadRecord.flags >>> 0, true)
    entryView.setUint32(entryOffset + 20, payloadRecord.offset >>> 0, true)
    entryView.setUint32(entryOffset + 24, payloadRecord.packedSize >>> 0, true)
    entryView.setUint32(entryOffset + 28, payloadRecord.rawSize >>> 0, true)
    entryView.setUint32(entryOffset + 32, payloadRecord.packedCrc >>> 0, true)
    entryView.setUint32(entryOffset + 36, payloadRecord.rawCrc >>> 0, true)
    writeU64LE(entryView, entryOffset + 40, 0n)
  }

  const stringBlob = concatUint8Arrays(stringParts, stringPoolSize)
  const payloadBlob = concatUint8Arrays(payloadParts, payloadSize)

  const header = new Uint8Array(EFWGPK_HEADER_SIZE)
  const headerView = new DataView(header.buffer)
  header.set(textEncoder.encode(MAGIC_EFWGPK), 0)
  headerView.setUint32(8, EFWGPK_HEADER_SIZE, true)
  const payloadNonce = randomBytes(NONCE_SIZE)
  const encryptedPayloadBlob = encryptCtr(payloadBlob, payloadNonce)

  headerView.setUint32(12, (EFWGPK_GLOBAL_PACKAGE | EFWGPK_GLOBAL_AES128_CTR) >>> 0, true)
  headerView.setUint32(16, EFWGPK_FORMAT_REVISION >>> 0, true)
  headerView.setUint32(20, entryCount >>> 0, true)
  headerView.setUint32(24, EFWGPK_ENTRY_SIZE >>> 0, true)
  headerView.setUint32(28, entriesOffset >>> 0, true)
  headerView.setUint32(32, stringPoolOffset >>> 0, true)
  headerView.setUint32(36, stringPoolSize >>> 0, true)
  headerView.setUint32(40, payloadOffset >>> 0, true)
  headerView.setUint32(44, payloadSize >>> 0, true)
  headerView.setUint32(48, 0, true)
  headerView.setUint32(52, 0, true)
  header.set(payloadNonce, 56)
  writeU64LE(headerView, 72, 0n)

  const tocBytes = concatUint8Arrays([header, entryRegion, stringBlob])
  const tocCrc = crc32(tocBytes)
  const payloadCrc = crc32(encryptedPayloadBlob)
  headerView.setUint32(48, tocCrc >>> 0, true)
  headerView.setUint32(52, payloadCrc >>> 0, true)

  return concatUint8Arrays([header, entryRegion, stringBlob, encryptedPayloadBlob])
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

const decodeEditChunkText = (inputBytes: Uint8Array): string => {
  if (getMagic(inputBytes, 4) !== MAGIC_EFKE) {
    return ''
  }

  const editChunk = readChunks(inputBytes, 8).find((chunk) => chunk.fourcc === EDIT_CHUNK_FOURCC)
  if (!editChunk || editChunk.payload.length === 0) {
    return ''
  }

  const candidates = [editChunk.payload]
  try {
    candidates.unshift(unzlibSync(editChunk.payload))
  } catch {
    // Ignore non-zlib payloads.
  }

  for (const candidate of candidates) {
    try {
      const decoded = textDecoder.decode(candidate).replace(/^\uFEFF/, '')
      if (decoded.includes('<')) {
        return decoded
      }
    } catch {
      // Try the next decode candidate.
    }
  }

  return ''
}

const extractDependencyPathsFromEfkefc = (inputBytes: Uint8Array): string[] => {
  const editText = decodeEditChunkText(inputBytes)
  if (!editText) {
    return []
  }

  const dependencies: string[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null = null
  RESOURCE_PATH_REGEX.lastIndex = 0
  while ((match = RESOURCE_PATH_REGEX.exec(editText)) !== null) {
    const rawPath = String(match[1] || '').trim().replace(/^['"]+|['"]+$/g, '')
    if (!rawPath) continue
    try {
      const normalized = normalizePathUtf8(rawPath)
      if (normalized === EFWGPK_META_MAIN || seen.has(normalized)) continue
      seen.add(normalized)
      dependencies.push(normalized)
    } catch {
      // Ignore malformed resource references in the editor payload.
    }
  }

  return dependencies.sort((a, b) => a.localeCompare(b))
}

const ensureRequiredDependenciesPresent = (
  inputBytes: Uint8Array,
  extraFiles: ConverterInputFile[]
) => {
  const requiredPaths = extractDependencyPathsFromEfkefc(inputBytes)
  if (requiredPaths.length === 0) {
    return
  }

  const availableAliases = new Set<string>()
  for (const dep of extraFiles) {
    const seedAliases = []
    if (dep.relativePath) seedAliases.push(dep.relativePath)
    if (dep.name) seedAliases.push(dep.name)

    for (const seed of seedAliases) {
      for (const alias of buildAliases(seed)) {
        availableAliases.add(alias)
      }
    }
  }

  const missing: string[] = []
  for (const requiredPath of requiredPaths) {
    const satisfied = buildAliases(requiredPath).some((alias) => availableAliases.has(alias))
    if (!satisfied) {
      missing.push(requiredPath)
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing dependency files. Provide deps folder. missing: ${missing.join(', ')}`)
  }
}

const buildEffectFromEfkefc = (
  inputName: string,
  inputBytes: Uint8Array
): ConvertedPackage => {
  const mainEffectPath = normalizePathUtf8(replaceExtension(inputName || 'effect.efkefc', '.efkwg'))
  const mainEffectBytes = buildEfwgFile(inputBytes)

  return {
    bytes: mainEffectBytes,
    outputName: replaceExtension(inputName || 'effect.efkefc', '.efkwg'),
    mainEffectPath,
    entries: 1,
    depsPacked: 0,
    profile: 'effect',
    backendRevision: 'v3',
  }
}

const buildPackageFromEfwg = (
  inputName: string,
  inputBytes: Uint8Array,
  extraFiles: ConverterInputFile[]
): ConvertedPackage => {
  const magic4 = getMagic(inputBytes, 4)
  if (magic4 !== MAGIC_EFWG && magic4 !== MAGIC_SKFE) {
    throw new Error(`unsupported efkwg source: magic=${magic4}`)
  }

  const pathToPayload = new Map<string, Uint8Array>()
  const mainEffectPath = normalizePathUtf8(inputName || 'effect.efkwg')
  addEntryWithDedupe(pathToPayload, mainEffectPath, inputBytes)
  addEntryWithDedupe(pathToPayload, EFWGPK_META_MAIN, textEncoder.encode(mainEffectPath))

  for (const dep of extraFiles) {
    if (!(dep.bytes instanceof Uint8Array) || dep.bytes.length === 0) {
      continue
    }

    const hashAlias = computeEffekseerHashName(dep.bytes)
    const seedAliases = [hashAlias]
    if (dep.relativePath) seedAliases.push(dep.relativePath)
    if (dep.name) seedAliases.push(dep.name)

    const lowerExt = getFileExtension(dep.name || dep.relativePath || '')
    if (lowerExt) {
      seedAliases.push(`${hashAlias}${lowerExt}`)
    }

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
    outputName: replaceExtension(inputName || 'effect.efkwg', '.efkwgpk'),
    mainEffectPath,
    entries: entries.length,
    depsPacked: Math.max(0, entries.length - 2),
    profile: 'package',
    backendRevision: 'v3',
  }
}

const buildPackageFromEfkpkg = (
  inputName: string,
  inputBytes: Uint8Array,
  extraFiles: ConverterInputFile[] = []
): ConvertedPackage => {
  const zipMap = unzipSync(inputBytes)
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
  const mainEffectBytes = buildEfwgFile(mainEffectPayload)
  addEntryWithDedupe(pathToPayload, mainEffectPath, mainEffectBytes)
  addEntryWithDedupe(pathToPayload, EFWGPK_META_MAIN, textEncoder.encode(mainEffectPath))

  const consumedZipKeys = new Set<string>([metafileKey, mainEffectKey])
  const referencedPaths = new Set<string>()
  for (const ref of extractBinaryDependencyRefs(mainEffectPayload)) {
    referencedPaths.add(ref)
  }

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

    for (const ref of extractBinaryDependencyRefs(payload)) {
      referencedPaths.add(ref)
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

  for (const dep of extraFiles) {
    if (!(dep.bytes instanceof Uint8Array) || dep.bytes.length === 0) {
      continue
    }

    const hashAlias = computeEffekseerHashName(dep.bytes)
    const seedAliases = [hashAlias]
    if (dep.relativePath) seedAliases.push(dep.relativePath)
    if (dep.name) seedAliases.push(dep.name)

    const lowerExt = getFileExtension(dep.name || dep.relativePath || '')
    if (lowerExt) {
      seedAliases.push(`${hashAlias}${lowerExt}`)
    }

    const seen = new Set<string>()
    for (const seed of seedAliases) {
      for (const alias of buildAliases(seed)) {
        if (seen.has(alias)) continue
        seen.add(alias)
        addEntryWithDedupe(pathToPayload, alias, dep.bytes)
      }
    }
  }

  for (const [zipKey, payload] of Object.entries(zipEntries)) {
    if (consumedZipKeys.has(zipKey) || !(payload instanceof Uint8Array) || payload.length === 0) {
      continue
    }

    for (const ref of extractBinaryDependencyRefs(payload)) {
      referencedPaths.add(ref)
    }

    const seen = new Set<string>()
    for (const alias of buildAliases(zipKey)) {
      if (seen.has(alias)) continue
      seen.add(alias)
      addEntryWithDedupe(pathToPayload, alias, payload)
    }
  }

  const unresolved = [...referencedPaths]
    .filter((ref) => ref !== EFWGPK_META_MAIN && !pathToPayload.has(ref))
    .sort((a, b) => a.localeCompare(b))
  if (unresolved.length > 0) {
    throw new Error(`Missing dependency files. Provide deps folder. missing: ${unresolved.join(', ')}`)
  }

  const entries = [...pathToPayload.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, payload]) => ({ path, payload }))

  return {
    bytes: buildEfwgpkBlob(entries),
    outputName: replaceExtension(inputName || 'effect.efkpkg', '.efkwgpk'),
    mainEffectPath,
    entries: entries.length,
    depsPacked: Math.max(0, entries.length - 2),
    profile: 'package',
    backendRevision: 'v3',
  }
}

export const convertToEfwgpk = async (
  inputName: string,
  inputBuffer: ArrayBuffer | Uint8Array,
  extraFiles: ConverterInputFile[] = []
): Promise<ConvertedPackage> => {
  const inputBytes = inputBuffer instanceof Uint8Array ? inputBuffer : new Uint8Array(inputBuffer)
  const ext = getFileExtension(inputName)
  const magic4 = getMagic(inputBytes, 4)

  if (ext === '.efkpkg' || magic4 === 'PK\u0003\u0004') {
    return buildPackageFromEfkpkg(inputName, inputBytes, extraFiles)
  }

  if (ext === '.efkefc' || magic4 === MAGIC_EFKE) {
    return buildEffectFromEfkefc(inputName, inputBytes)
  }

  if (ext === '.efkwg' || magic4 === MAGIC_EFWG || magic4 === MAGIC_SKFE) {
    return buildPackageFromEfwg(inputName, inputBytes, extraFiles)
  }

  throw new Error('input must be .efkefc, .efkwg, or .efkpkg')
}
