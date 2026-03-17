import type { ConvertedPackage, ConverterInputFile } from './efwgpkConverter'

type NativeConvertRequest = {
  sourceName: string
  sourceBase64: string
  injectMesh?: boolean
  deps: Array<{
    name: string
    relativePath: string
    bytesBase64: string
  }>
}

type NativeConvertResponse = {
  bytesBase64: string
  outputName: string
  downloadBytesBase64?: string
  downloadOutputName?: string
  entries: number
  depsPacked: number
  meshInjected?: boolean
  injectWarning?: string
  backendRevision?: string
}

export type NativeConvertOptions = {
  injectMesh?: boolean
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const NATIVE_CONVERT_ENDPOINT = '/api/native-convert'

const readMagic8 = (bytes: Uint8Array): string => {
  const len = Math.min(8, bytes.length)
  let s = ''
  for (let i = 0; i < len; i++) {
    s += String.fromCharCode(bytes[i])
  }
  return s
}

export const convertToEfwgpkNative = async (
  inputName: string,
  inputBuffer: ArrayBuffer | Uint8Array,
  extraFiles: ConverterInputFile[],
  options?: NativeConvertOptions
): Promise<ConvertedPackage> => {
  const inputBytes = inputBuffer instanceof Uint8Array ? inputBuffer : new Uint8Array(inputBuffer)

  const payload: NativeConvertRequest = {
    sourceName: inputName,
    sourceBase64: bytesToBase64(inputBytes),
    injectMesh: options?.injectMesh ?? true,
    deps: extraFiles.map((file) => ({
      name: file.name,
      relativePath: file.relativePath || file.name,
      bytesBase64: bytesToBase64(file.bytes),
    })),
  }

  const response = await fetch(NATIVE_CONVERT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const responseText = await response.text()
  let responseData: NativeConvertResponse | { error?: string }
  try {
    responseData = JSON.parse(responseText)
  } catch {
    throw new Error(`Native converter returned invalid JSON: ${responseText.slice(0, 200)}`)
  }

  if (!response.ok) {
    const message = typeof responseData === 'object' && responseData && 'error' in responseData
      ? String(responseData.error || 'Native converter failed')
      : `Native converter failed with HTTP ${response.status}`
    throw new Error(message)
  }

  const converted = responseData as NativeConvertResponse
  const bytes = base64ToBytes(converted.bytesBase64)
  const magic8 = readMagic8(bytes)
  if (magic8 !== 'EFWGPKG1') {
    throw new Error(
      `Native converter returned invalid package (magic="${magic8 || 'unknown'}"). ` +
      'Expected EFWGPKG1.'
    )
  }

  return {
    bytes,
    outputName: converted.outputName || (inputName.replace(/\.[^.]+$/, '') + '.efkwgpk'),
    downloadBytes: converted.downloadBytesBase64 ? base64ToBytes(converted.downloadBytesBase64) : undefined,
    downloadOutputName: converted.downloadOutputName,
    mainEffectPath: '',
    entries: converted.entries || 0,
    depsPacked: converted.depsPacked || extraFiles.length,
    profile: 'package',
    meshInjected: converted.meshInjected,
    injectWarning: converted.injectWarning,
    backendRevision: converted.backendRevision,
  }
}
