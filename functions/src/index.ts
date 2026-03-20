import { onRequest } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import {
  FieldValue,
  Timestamp,
  getFirestore,
  type DocumentReference,
} from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import type { Request, Response } from 'express'
import Busboy from 'busboy'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { convertToEfwgpk, type ConverterInputFile } from './effectConversion/converter'

type JsonMap = Record<string, unknown>

type AuthenticatedUser = {
  uid: string
  email: string | null
  displayName: string | null
  photoURL: string | null
}

type CreditPackId = 'starter_10' | 'value_40'

type UserDocShape = {
  uid: string
  email: string | null
  displayName: string
  photoURL: string | null
  avatarSeed: string
  billingProvider: 'lemonsqueezy'
  creditsBalance: number
  freePreviewConversionsUsed: number
  lifetimeCreditsPurchased: number
  lifetimeCreditsSpent: number
  lemonsqueezyCustomerId: string | null
  lastCreditGrantOrderId: string | null
  lastCreditGrantAt: string | null
}

type ArtifactDocShape = {
  artifactId: string
  outputName: string
  displayName: string
  storagePath: string
  bytesLength: number
  sha256: string
  sourceName: string
  unlockStatus: 'locked' | 'unlocked'
  unlockedAt: Timestamp | null
  unlockCostCredits: 1
}

type CreditOrderDocShape = {
  orderId: string
  uid: string
  packId: CreditPackId
  variantId: string
  creditsGranted: number
  status: 'paid' | 'refunded'
  lemonsqueezyCustomerId: string | null
  refundedAt: Timestamp | null
}

type CheckoutSessionRequest = {
  packId?: string
  returnUrl?: string
  artifactId?: string
}

type RegisterConvertedArtifactRequest = {
  outputName?: string
  sourceName?: string
  bytesBase64?: string
  sha256?: string
  bytesLength?: number
}

type StartEffectConversionRequest = {
  sourceName?: string
  sourceBytesBase64?: string
  extraFiles?: Array<{
    name?: string
    relativePath?: string
    bytesBase64?: string
  }>
}

type StartEffectConversionResponse = {
  artifactId?: string
  alreadyExisted: boolean
  outputName: string
  mainEffectPath: string
  bytesLength: number
  sha256: string
  status: 'completed'
}

type StartEffectConversionBinaryRequest = {
  sourceName: string
  sourceBytes: Uint8Array
  extraFiles: ConverterInputFile[]
}

type MultipartConversionFile = {
  fieldName: string
  fileName: string
  bytes: Uint8Array
}

type MultipartConversionPayload = {
  fields: Map<string, string[]>
  files: MultipartConversionFile[]
}

type ConversionJobDocShape = {
  jobId: string
  sourceName: string
  sourceStoragePath: string
  outputName: string | null
  artifactId: string | null
  status: 'uploading' | 'processing' | 'completed' | 'failed'
  errorMessage: string | null
}

type ConsumeUnlockCreditRequest = {
  artifactId?: string
}

type DeleteAccountArtifactRequest = {
  artifactId?: string
}

type LoadAccountArtifactBytesRequest = {
  artifactId?: string
}

const FUNCTION_REGION = process.env.FUNCTION_REGION || 'us-central1'
const BILLING_PROVIDER = 'lemonsqueezy'
const USERS_COLLECTION = 'users'
const ARTIFACTS_COLLECTION = 'artifacts'
const CONVERSION_JOBS_COLLECTION = 'conversionJobs'
const BILLING_EVENTS_COLLECTION = 'billingEvents'
const CREDIT_ORDERS_COLLECTION = 'creditOrders'
const DOWNLOAD_URL_TTL_MS = 15 * 60 * 1000
const IS_FUNCTIONS_EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true' || !!process.env.FIREBASE_EMULATOR_HUB
const FREE_PREVIEW_CONVERSION_LIMIT = 5
const CREDIT_PACKS = {
  starter_10: {
    packId: 'starter_10',
    label: 'Starter Pack',
    credits: 10,
    env: 'LEMONSQUEEZY_CREDIT_PACK_10_VARIANT_ID',
  },
  value_40: {
    packId: 'value_40',
    label: 'Value Pack',
    credits: 40,
    env: 'LEMONSQUEEZY_CREDIT_PACK_40_VARIANT_ID',
  },
} as const satisfies Record<CreditPackId, {
  packId: CreditPackId
  label: string
  credits: number
  env: string
}>

const adminApp = getApps().length > 0 ? getApps()[0] : initializeApp()
const adminAuth = getAuth(adminApp)
const adminDb = getFirestore(adminApp)
const adminStorage = getStorage(adminApp)
const usersCollection = adminDb.collection(USERS_COLLECTION)
const billingEventsCollection = adminDb.collection(BILLING_EVENTS_COLLECTION)
const creditOrdersCollection = adminDb.collection(CREDIT_ORDERS_COLLECTION)

const isRecord = (value: unknown): value is JsonMap => !!value && typeof value === 'object' && !Array.isArray(value)

const getString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const getIsoString = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    const time = Date.parse(value)
    return Number.isFinite(time) ? new Date(time).toISOString() : null
  }
  return null
}

const parseJsonRecord = (body: unknown): JsonMap => {
  if (isRecord(body)) return body
  if (typeof body === 'string') return JSON.parse(body) as JsonMap
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8')) as JsonMap
  throw new Error('invalid JSON body')
}

const sendJsonError = (
  res: Response,
  status: number,
  message: string,
  extra?: Record<string, unknown>
) => {
  res.status(status).json({
    error: message,
    ...(extra ?? {}),
  })
}

const getBearerToken = (authorization: string | undefined): string | null => {
  if (!authorization) return null
  const match = /^Bearer\s+(.+)$/i.exec(authorization)
  return match?.[1] ?? null
}

const authenticateRequest = async (req: Request): Promise<AuthenticatedUser> => {
  const token = getBearerToken(req.headers.authorization)
  if (!token) {
    throw new Error('Authentication required.')
  }

  const decoded = await adminAuth.verifyIdToken(token)
  return {
    uid: decoded.uid,
    email: typeof decoded.email === 'string' ? decoded.email : null,
    displayName: typeof decoded.name === 'string' ? decoded.name : null,
    photoURL: typeof decoded.picture === 'string' ? decoded.picture : null,
  }
}

const sanitizeFilename = (value: string, fallback: string): string => {
  const name = path.basename(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '_')
  return name.length > 0 ? name : fallback
}

const createAvatarSeed = (user: AuthenticatedUser): string => (
  getString(user.email)?.split('@')[0]?.slice(0, 24) ||
  getString(user.displayName)?.slice(0, 24) ||
  user.uid.slice(0, 24)
)

const defaultUserDoc = (user: AuthenticatedUser): UserDocShape => ({
  uid: user.uid,
  email: user.email,
  displayName: getString(user.displayName) || 'User',
  photoURL: user.photoURL,
  avatarSeed: createAvatarSeed(user),
  billingProvider: BILLING_PROVIDER,
  creditsBalance: 0,
  freePreviewConversionsUsed: 0,
  lifetimeCreditsPurchased: 0,
  lifetimeCreditsSpent: 0,
  lemonsqueezyCustomerId: null,
  lastCreditGrantOrderId: null,
  lastCreditGrantAt: null,
})

const mergeUserDoc = (
  user: AuthenticatedUser,
  raw: JsonMap | undefined
): UserDocShape => {
  const fallback = defaultUserDoc(user)
  const credits = typeof raw?.creditsBalance === 'number' ? raw.creditsBalance : fallback.creditsBalance
  const freePreviewConversionsUsed = typeof raw?.freePreviewConversionsUsed === 'number'
    ? raw.freePreviewConversionsUsed
    : fallback.freePreviewConversionsUsed
  const lifetimeCreditsPurchased = typeof raw?.lifetimeCreditsPurchased === 'number'
    ? raw.lifetimeCreditsPurchased
    : fallback.lifetimeCreditsPurchased
  const lifetimeCreditsSpent = typeof raw?.lifetimeCreditsSpent === 'number'
    ? raw.lifetimeCreditsSpent
    : fallback.lifetimeCreditsSpent

  return {
    uid: getString(raw?.uid) || fallback.uid,
    email: getString(raw?.email) ?? fallback.email,
    displayName: getString(raw?.displayName) || fallback.displayName,
    photoURL: getString(raw?.photoURL),
    avatarSeed: getString(raw?.avatarSeed) || fallback.avatarSeed,
    billingProvider: BILLING_PROVIDER,
    creditsBalance: Number.isFinite(credits) ? Math.trunc(credits) : fallback.creditsBalance,
    freePreviewConversionsUsed: Number.isFinite(freePreviewConversionsUsed)
      ? Math.max(0, Math.trunc(freePreviewConversionsUsed))
      : fallback.freePreviewConversionsUsed,
    lifetimeCreditsPurchased: Number.isFinite(lifetimeCreditsPurchased)
      ? Math.max(0, Math.trunc(lifetimeCreditsPurchased))
      : fallback.lifetimeCreditsPurchased,
    lifetimeCreditsSpent: Number.isFinite(lifetimeCreditsSpent)
      ? Math.max(0, Math.trunc(lifetimeCreditsSpent))
      : fallback.lifetimeCreditsSpent,
    lemonsqueezyCustomerId: getString(raw?.lemonsqueezyCustomerId),
    lastCreditGrantOrderId: getString(raw?.lastCreditGrantOrderId),
    lastCreditGrantAt: getIsoString(raw?.lastCreditGrantAt),
  }
}

const userDocWrite = (
  userDoc: UserDocShape,
  options?: { includeCreatedAt?: boolean }
) => ({
  ...userDoc,
  updatedAt: FieldValue.serverTimestamp(),
  ...(options?.includeCreatedAt ? { createdAt: FieldValue.serverTimestamp() } : {}),
})

const ensureUserDoc = async (user: AuthenticatedUser): Promise<{
  ref: DocumentReference
  data: UserDocShape
}> => {
  const ref = usersCollection.doc(user.uid)
  const snapshot = await ref.get()
  const data = mergeUserDoc(user, snapshot.data() as JsonMap | undefined)
  await ref.set(userDocWrite(data, { includeCreatedAt: !snapshot.exists }), { merge: true })
  return { ref, data }
}

const getConversionEntitlement = (
  userDoc: Pick<UserDocShape, 'creditsBalance' | 'freePreviewConversionsUsed'>
): 'paid' | 'free' | 'blocked' => {
  if (userDoc.creditsBalance > 0) {
    return 'paid'
  }
  if (userDoc.freePreviewConversionsUsed < FREE_PREVIEW_CONVERSION_LIMIT) {
    return 'free'
  }
  return 'blocked'
}

const getUserDocByIdentifiers = async (identifiers: {
  uid?: string | null
  customerId?: string | null
}): Promise<DocumentReference | null> => {
  if (identifiers.uid) {
    return usersCollection.doc(identifiers.uid)
  }

  if (identifiers.customerId) {
    const snapshot = await usersCollection
      .where('lemonsqueezyCustomerId', '==', identifiers.customerId)
      .limit(1)
      .get()
    if (!snapshot.empty) {
      return snapshot.docs[0].ref
    }
  }

  return null
}

const hashSha256Hex = (input: Uint8Array | Buffer | string): string => (
  createHash('sha256').update(input).digest('hex')
)

const decodeBase64Buffer = (value: string): Buffer => Buffer.from(value, 'base64')

const getHeaderString = (req: Request, name: string): string | undefined => {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

const isMultipartRequest = (req: Request): boolean => {
  const contentType = getHeaderString(req, 'content-type') || ''
  return contentType.toLowerCase().startsWith('multipart/form-data')
}

const parseMultipartPayload = async (req: Request): Promise<MultipartConversionPayload> => {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody
  if (!rawBody || rawBody.byteLength === 0) {
    throw new Error('multipart request body is empty.')
  }

  return await new Promise<MultipartConversionPayload>((resolve, reject) => {
    const fields = new Map<string, string[]>()
    const files: MultipartConversionFile[] = []
    const busboy = Busboy({
      headers: req.headers as Record<string, string>,
    })

    busboy.on('field', (name: string, value: string) => {
      const existing = fields.get(name) ?? []
      existing.push(value)
      fields.set(name, existing)
    })

    busboy.on('file', (name: string, file: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      const chunks: Buffer[] = []
      file.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      file.on('end', () => {
        files.push({
          fieldName: name,
          fileName: info.filename || 'file.bin',
          bytes: new Uint8Array(Buffer.concat(chunks)),
        })
      })
    })

    busboy.on('error', reject)
    busboy.on('finish', () => resolve({ fields, files }))
    busboy.end(rawBody)
  })
}

const parseJsonStartEffectConversionRequest = (req: Request): StartEffectConversionBinaryRequest => {
  const body = parseJsonRecord(req.body) as StartEffectConversionRequest
  const sourceName = sanitizeFilename(getString(body.sourceName) || '', 'effect.efkefc')
  const sourceBytesBase64 = getString(body.sourceBytesBase64)

  if (!sourceName) {
    throw new Error('sourceName is required.')
  }
  if (!sourceBytesBase64) {
    throw new Error('sourceBytesBase64 is required.')
  }

  const extraFilesRaw = Array.isArray(body.extraFiles) ? body.extraFiles : []
  const extraFiles: ConverterInputFile[] = []
  for (const entry of extraFilesRaw) {
    const bytesBase64 = getString(entry?.bytesBase64)
    if (!bytesBase64) {
      throw new Error('extraFiles[].bytesBase64 is required when extraFiles are provided.')
    }

    const relativePath = getString(entry?.relativePath) || sanitizeFilename(getString(entry?.name) || 'dep.bin', 'dep.bin')
    const name = sanitizeFilename(getString(entry?.name) || path.posix.basename(relativePath), 'dep.bin')
    extraFiles.push({
      name,
      relativePath,
      bytes: new Uint8Array(decodeBase64Buffer(bytesBase64)),
    })
  }

  return {
    sourceName,
    sourceBytes: new Uint8Array(decodeBase64Buffer(sourceBytesBase64)),
    extraFiles,
  }
}

const parseMultipartStartEffectConversionRequest = async (req: Request): Promise<StartEffectConversionBinaryRequest> => {
  const payload = await parseMultipartPayload(req)
  const manifestText = payload.fields.get('manifest')?.[0] || ''
  if (!manifestText) {
    throw new Error('manifest is required.')
  }

  let manifest: {
    sourceName?: string
    extraFiles?: Array<{ fieldName?: string; name?: string; relativePath?: string }>
  }
  try {
    manifest = JSON.parse(manifestText) as {
      sourceName?: string
      extraFiles?: Array<{ fieldName?: string; name?: string; relativePath?: string }>
    }
  } catch (error) {
    throw new Error(`invalid manifest JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  const sourceFile = payload.files.find((entry) => entry.fieldName === 'source')
  if (!sourceFile || sourceFile.bytes.byteLength === 0) {
    throw new Error('source file is required.')
  }

  const sourceName = sanitizeFilename(getString(manifest.sourceName) || sourceFile.fileName || 'effect.efkefc', 'effect.efkefc')
  const extraFiles: ConverterInputFile[] = []
  for (const meta of Array.isArray(manifest.extraFiles) ? manifest.extraFiles : []) {
    const fieldName = getString(meta.fieldName)
    if (!fieldName) continue
    const file = payload.files.find((entry) => entry.fieldName === fieldName)
    if (!file || file.bytes.byteLength === 0) continue
    const relativePath = getString(meta.relativePath) || getString(meta.name) || file.fileName || 'dep.bin'
    const name = sanitizeFilename(getString(meta.name) || path.posix.basename(relativePath), 'dep.bin')
    extraFiles.push({
      name,
      relativePath,
      bytes: file.bytes,
    })
  }

  return {
    sourceName,
    sourceBytes: sourceFile.bytes,
    extraFiles,
  }
}

const parseStartEffectConversionRequest = async (req: Request): Promise<StartEffectConversionBinaryRequest> => (
  isMultipartRequest(req)
    ? await parseMultipartStartEffectConversionRequest(req)
    : parseJsonStartEffectConversionRequest(req)
)

const START_EFFECT_CONVERSION_EXPOSE_HEADERS = [
  'X-Artifact-Id',
  'X-Already-Existed',
  'X-Output-Name',
  'X-Main-Effect-Path',
  'X-Bytes-Length',
  'X-Sha256',
  'X-Status',
].join(', ')

const LOAD_ACCOUNT_ARTIFACT_EXPOSE_HEADERS = [
  'X-Output-Name',
  'X-Bytes-Length',
  'X-Sha256',
].join(', ')

const sendStartEffectConversionBinary = (
  res: Response,
  meta: StartEffectConversionResponse,
  bytes: Uint8Array
) => {
  res.status(200)
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Length', String(bytes.byteLength))
  res.setHeader('Access-Control-Expose-Headers', START_EFFECT_CONVERSION_EXPOSE_HEADERS)
  res.setHeader('X-Already-Existed', meta.alreadyExisted ? '1' : '0')
  res.setHeader('X-Output-Name', meta.outputName)
  res.setHeader('X-Main-Effect-Path', meta.mainEffectPath)
  res.setHeader('X-Bytes-Length', String(meta.bytesLength))
  res.setHeader('X-Sha256', meta.sha256)
  res.setHeader('X-Status', meta.status)
  if (meta.artifactId) {
    res.setHeader('X-Artifact-Id', meta.artifactId)
  }
  res.send(Buffer.from(bytes))
}

const getArtifactRef = (uid: string, artifactId: string) => (
  usersCollection.doc(uid).collection(ARTIFACTS_COLLECTION).doc(artifactId)
)

const getConversionJobRef = (uid: string, jobId: string) => (
  usersCollection.doc(uid).collection(CONVERSION_JOBS_COLLECTION).doc(jobId)
)

const normalizeStoragePath = (value: string): string => value.replace(/\\/g, '/').replace(/^\/+/, '')

const assertUserConversionStoragePath = (uid: string, jobId: string, storagePath: string, kind: 'source' | 'extra'): string => {
  const normalized = normalizeStoragePath(storagePath)
  const basePrefix = `users/${uid}/conversion-jobs/${jobId}/input/`
  if (!normalized.startsWith(basePrefix)) {
    throw new Error('storage path does not belong to the authenticated conversion job.')
  }

  if (kind === 'source') {
    if (normalized !== `${basePrefix}source`) {
      throw new Error('sourceStoragePath must point to users/{uid}/conversion-jobs/{jobId}/input/source.')
    }
    return normalized
  }

  if (!normalized.startsWith(`${basePrefix}extras/`)) {
    throw new Error('extra file storagePath must point to users/{uid}/conversion-jobs/{jobId}/input/extras/.')
  }
  return normalized
}

const readStorageBytes = async (storagePath: string): Promise<Uint8Array> => {
  const [bytes] = await adminStorage.bucket().file(storagePath).download()
  return new Uint8Array(bytes)
}

const writeConversionJob = async (
  uid: string,
  jobId: string,
  data: ConversionJobDocShape,
  options?: { includeCreatedAt?: boolean }
) => {
  await getConversionJobRef(uid, jobId).set(
    {
      ...data,
      ...(options?.includeCreatedAt ? { createdAt: FieldValue.serverTimestamp() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  )
}

const saveArtifactForUser = async (options: {
  uid: string
  outputName: string
  sourceName: string
  bytes: Uint8Array | Buffer
}): Promise<{
  artifactId: string
  storagePath: string
  sha256: string
  bytesLength: number
  alreadyExisted: boolean
}> => {
  const bytes = options.bytes instanceof Uint8Array ? Buffer.from(options.bytes) : Buffer.from(options.bytes)
  const sha256 = hashSha256Hex(bytes)
  const artifactId = sha256
  const artifactRef = getArtifactRef(options.uid, artifactId)
  const existingSnapshot = await artifactRef.get()
  if (existingSnapshot.exists) {
    const existingData = existingSnapshot.data() as JsonMap | undefined
    const existingStoragePath = getString(existingData?.storagePath)
    return {
      artifactId,
      storagePath: existingStoragePath || `users/${options.uid}/artifacts/${artifactId}/${options.outputName}`,
      sha256,
      bytesLength: bytes.byteLength,
      alreadyExisted: true,
    }
  }

  const storagePath = `users/${options.uid}/artifacts/${artifactId}/${options.outputName}`
  await adminStorage.bucket().file(storagePath).save(bytes, {
    resumable: false,
    contentType: 'application/octet-stream',
    metadata: {
      cacheControl: 'private, max-age=0, no-store',
      metadata: {
        uid: options.uid,
        artifactId,
        sha256,
        sourceName: options.sourceName,
        outputName: options.outputName,
      },
    },
  })

  const artifactData: ArtifactDocShape = {
    artifactId,
    outputName: options.outputName,
    displayName: options.outputName,
    storagePath,
    bytesLength: bytes.byteLength,
    sha256,
    sourceName: options.sourceName,
    unlockStatus: 'locked',
    unlockedAt: null,
    unlockCostCredits: 1,
  }

  await artifactRef.set(
    {
      ...artifactData,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  )

  return {
    artifactId,
    storagePath,
    sha256,
    bytesLength: bytes.byteLength,
    alreadyExisted: false,
  }
}

const parseMissingDependencyFailure = (message: string): string[] | null => {
  if (!/missing dependency files/i.test(message) || !/provide deps folder/i.test(message)) {
    return null
  }

  const match = /missing:\s*([\s\S]+)/i.exec(message)
  if (!match?.[1]) {
    return []
  }

  return match[1]
    .split(/[,|\r\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

const getArtifactDownloadUrl = async (storagePath: string): Promise<string> => {
  const bucket = adminStorage.bucket()
  const outputName = path.basename(storagePath).replace(/"/g, '')
  const [url] = await bucket.file(storagePath).getSignedUrl({
    action: 'read',
    expires: Date.now() + DOWNLOAD_URL_TTL_MS,
    responseDisposition: `attachment; filename="${outputName}"`,
  })
  return url
}

const getCreditPackById = (value: string | null | undefined) => {
  if (value === 'starter_10' || value === 'value_40') {
    return CREDIT_PACKS[value]
  }
  return null
}

const getConfiguredCreditPackById = (value: string | null | undefined) => {
  const pack = getCreditPackById(value)
  if (!pack) return null

  const variantId = getRequiredEnv(pack.env)
  const numericVariantId = Number.parseInt(variantId, 10)
  if (!Number.isFinite(numericVariantId)) {
    throw new Error(`${pack.env} must be a numeric variant id.`)
  }

  return {
    ...pack,
    variantId,
    numericVariantId,
  }
}

const getConfiguredCreditPackByVariantId = (variantId: string | null | undefined) => {
  if (!variantId) return null

  for (const pack of Object.values(CREDIT_PACKS)) {
    const configuredVariantId = process.env[pack.env]
    if (configuredVariantId && configuredVariantId === variantId) {
      return {
        ...pack,
        variantId: configuredVariantId,
      }
    }
  }

  return null
}

const getRequiredEnv = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

const LEMONSQUEEZY_API_PREFIX = ['https://api.lemonsqueezy.com', 'v', '1'].join('/')

const lemonFetch = async (pathname: string, init?: RequestInit) => {
  const apiKey = getRequiredEnv('LEMONSQUEEZY_API_KEY')
  const response = await fetch(`${LEMONSQUEEZY_API_PREFIX}${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.api+json',
      Authorization: `Bearer ${apiKey}`,
      ...(init?.body ? { 'Content-Type': 'application/vnd.api+json' } : {}),
      ...(init?.headers ?? {}),
    },
  })

  const text = await response.text()
  const payload = text ? JSON.parse(text) as JsonMap : {}
  if (!response.ok) {
    const errors = Array.isArray(payload.errors) ? payload.errors : []
    const detail = errors
      .map((entry) => isRecord(entry) ? getString(entry.detail) || getString(entry.title) : null)
      .filter((value): value is string => !!value)
      .join('; ')
    throw new Error(detail || `LemonSqueezy request failed with HTTP ${response.status}`)
  }
  return payload
}

const verifyWebhookSignature = (
  rawBody: Buffer,
  signature: string | undefined
): boolean => {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET
  if (!secret || !signature) return false

  const digest = createHmac('sha256', secret).update(rawBody).digest('hex')
  const expected = Buffer.from(digest, 'hex')
  const received = Buffer.from(signature, 'hex')
  return expected.length === received.length && timingSafeEqual(expected, received)
}

const deriveWebhookEventId = (rawBody: Buffer): string => hashSha256Hex(rawBody)

const extractCustomData = (payload: JsonMap): JsonMap => {
  const meta = isRecord(payload.meta) ? payload.meta : {}
  return isRecord(meta.custom_data) ? meta.custom_data : {}
}

const extractLemonData = (payload: JsonMap): JsonMap => (
  isRecord(payload.data) ? payload.data : {}
)

const extractLemonAttributes = (payload: JsonMap): JsonMap => {
  const data = extractLemonData(payload)
  return isRecord(data.attributes) ? data.attributes : {}
}

const extractOrderIdentifiers = (payload: JsonMap) => {
  const data = extractLemonData(payload)
  const attributes = extractLemonAttributes(payload)
  const customData = extractCustomData(payload)
  const firstOrderItem = isRecord(attributes.first_order_item) ? attributes.first_order_item : {}
  const orderId =
    getString(data.id) ||
    getString(attributes.order_id) ||
    getString(customData.order_id)

  return {
    uid:
      getString(customData.uid) ||
      getString(customData.user_id) ||
      getString(customData.app_user_id),
    customerId:
      getString(attributes.customer_id) ||
      getString(attributes.customer_id_string) ||
      getString(customData.customer_id),
    packId:
      getString(customData.packId) ||
      getString(customData.pack_id),
    variantId:
      getString(firstOrderItem.variant_id) ||
      getString(attributes.variant_id) ||
      getString(customData.variant_id),
    orderId,
  }
}

const handleCreateCreditPackCheckoutSession = async (req: Request, res: Response) => {
  if (req.method !== 'POST') {
    sendJsonError(res, 405, 'method not allowed')
    return
  }

  try {
    const user = await authenticateRequest(req)
    const body = parseJsonRecord(req.body) as CheckoutSessionRequest
    const pack = getConfiguredCreditPackById(getString(body.packId))
    if (!pack) {
      sendJsonError(res, 400, 'packId must be starter_10 or value_40.')
      return
    }

    const returnUrl = getString(body.returnUrl)
    if (!returnUrl || !/^https?:\/\//i.test(returnUrl)) {
      throw new Error('returnUrl must be an absolute http(s) URL.')
    }

    await ensureUserDoc(user)

    const storeId = getRequiredEnv('LEMONSQUEEZY_STORE_ID')
    const checkoutResponse = await lemonFetch('/checkouts', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: user.email ?? undefined,
              name: user.displayName ?? undefined,
              custom: {
                uid: user.uid,
                email: user.email ?? '',
                artifactId: getString(body.artifactId) ?? '',
                packId: pack.packId,
              },
            },
            checkout_options: {
              embed: false,
              media: true,
              logo: true,
            },
            product_options: {
              redirect_url: returnUrl,
              receipt_button_text: 'Return to app',
              receipt_link_url: returnUrl,
              enabled_variants: [pack.numericVariantId],
            },
          },
          relationships: {
            store: {
              data: {
                type: 'stores',
                id: storeId,
              },
            },
            variant: {
              data: {
                type: 'variants',
                id: pack.variantId,
              },
            },
          },
        },
      }),
    })

    const checkoutData = extractLemonData(checkoutResponse)
    const checkoutAttributes = isRecord(checkoutData.attributes) ? checkoutData.attributes : {}
    const checkoutUrl = getString(checkoutAttributes.url)
    if (!checkoutUrl) {
      throw new Error('LemonSqueezy did not return a checkout URL.')
    }

    res.status(200).json({ checkoutUrl })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('createCreditPackCheckoutSession failed', message)
    sendJsonError(res, 500, message)
  }
}

export const createCreditPackCheckoutSession = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    cors: true,
  },
  handleCreateCreditPackCheckoutSession
)

// Backward-compatible alias while client envs migrate to the pack-based endpoint name.
export const createSubscriptionCheckoutSession = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    cors: true,
  },
  handleCreateCreditPackCheckoutSession
)

export const createCustomerPortalSession = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    cors: true,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      sendJsonError(res, 405, 'method not allowed')
      return
    }

    sendJsonError(res, 410, 'Customer portal is not available for one-time credit packs.')
  }
)

export const startEffectConversion = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '1GiB',
    cors: true,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      sendJsonError(res, 405, 'method not allowed')
      return
    }

    try {
      let userRef: DocumentReference | null = null
      let conversionEntitlement: 'paid' | 'free' | 'blocked' = 'free'
      if (!IS_FUNCTIONS_EMULATOR) {
        const user = await authenticateRequest(req)
        const ensuredUser = await ensureUserDoc(user)
        userRef = ensuredUser.ref
        conversionEntitlement = getConversionEntitlement(ensuredUser.data)
        if (conversionEntitlement === 'blocked') {
          sendJsonError(
            res,
            403,
            'This account cannot convert more effects until credits are purchased.',
            {
              code: 'preview_conversion_limit_reached',
              purchaseRequired: true,
            }
          )
          return
        }
      }

      const { sourceName, sourceBytes, extraFiles } = await parseStartEffectConversionRequest(req)

      const converted = await convertToEfwgpk(sourceName, sourceBytes, extraFiles)
      const previewSha256 = hashSha256Hex(converted.bytes)

      if (IS_FUNCTIONS_EMULATOR) {
        const response: StartEffectConversionResponse = {
          alreadyExisted: false,
          outputName: converted.outputName,
          mainEffectPath: converted.mainEffectPath,
          bytesLength: converted.bytes.byteLength,
          sha256: previewSha256,
          status: 'completed',
        }
        sendStartEffectConversionBinary(res, response, converted.bytes)
        return
      }

      await userRef!.set(
        {
          freePreviewConversionsUsed: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      )

      const response: StartEffectConversionResponse = {
        alreadyExisted: false,
        outputName: converted.outputName,
        mainEffectPath: converted.mainEffectPath,
        bytesLength: converted.bytes.byteLength,
        sha256: previewSha256,
        status: 'completed',
      }
      sendStartEffectConversionBinary(res, response, converted.bytes)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('startEffectConversion failed', message)
      if (message === 'Authentication required.') {
        sendJsonError(res, 401, message)
        return
      }
      sendJsonError(res, 500, message)
    }
  }
)

export const registerConvertedArtifact = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    memory: '1GiB',
    cors: true,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      sendJsonError(res, 405, 'method not allowed')
      return
    }

    try {
      const user = await authenticateRequest(req)
      await ensureUserDoc(user)

      const body = parseJsonRecord(req.body) as RegisterConvertedArtifactRequest
      const outputName = sanitizeFilename(getString(body.outputName) || '', 'converted.efkwgpk')
      const sourceName = sanitizeFilename(getString(body.sourceName) || '', 'effect.efkefc')
      const bytesBase64 = getString(body.bytesBase64)
      const clientSha256 = getString(body.sha256)
      const clientBytesLength = typeof body.bytesLength === 'number' ? body.bytesLength : null

      if (!bytesBase64) {
        throw new Error('bytesBase64 is required.')
      }

      const bytes = decodeBase64Buffer(bytesBase64)
      const sha256 = hashSha256Hex(bytes)
      if (clientSha256 && clientSha256 !== sha256) {
        throw new Error('sha256 does not match uploaded artifact bytes.')
      }
      if (clientBytesLength !== null && clientBytesLength !== bytes.byteLength) {
        throw new Error('bytesLength does not match uploaded artifact bytes.')
      }

      const artifact = await saveArtifactForUser({
        uid: user.uid,
        outputName,
        sourceName,
        bytes,
      })

      res.status(200).json({ artifactId: artifact.artifactId, alreadyExisted: artifact.alreadyExisted })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('registerConvertedArtifact failed', message)
      sendJsonError(res, 500, message)
    }
  }
)

export const consumeUnlockCredit = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    cors: true,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      sendJsonError(res, 405, 'method not allowed')
      return
    }

    try {
      const user = await authenticateRequest(req)
      const { ref: userRef } = await ensureUserDoc(user)
      const body = parseJsonRecord(req.body) as ConsumeUnlockCreditRequest
      const artifactId = getString(body.artifactId)
      if (!artifactId) {
        throw new Error('artifactId is required.')
      }

      const artifactRef = getArtifactRef(user.uid, artifactId)
      const result = await adminDb.runTransaction(async (transaction) => {
        const [userSnapshot, artifactSnapshot] = await Promise.all([
          transaction.get(userRef),
          transaction.get(artifactRef),
        ])

        if (!artifactSnapshot.exists) {
          throw new Error('Artifact not found for this account.')
        }

        const mergedUser = mergeUserDoc(user, userSnapshot.data() as JsonMap | undefined)
        const artifactData = artifactSnapshot.data() as JsonMap
        const storagePath = getString(artifactData.storagePath)
        if (!storagePath) {
          throw new Error('Artifact storage path is missing.')
        }

        if (getString(artifactData.unlockStatus) === 'unlocked') {
          return {
            creditsBalance: mergedUser.creditsBalance,
            storagePath,
            alreadyUnlocked: true,
          }
        }

        if (mergedUser.creditsBalance < 1) {
          throw new Error('You need at least 1 credit to unlock this download.')
        }

        transaction.set(
          userRef,
          {
            ...userDocWrite({
              ...mergedUser,
              creditsBalance: mergedUser.creditsBalance - 1,
              lifetimeCreditsSpent: mergedUser.lifetimeCreditsSpent + 1,
            }),
          },
          { merge: true }
        )
        transaction.set(
          artifactRef,
          {
            unlockStatus: 'unlocked',
            unlockedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )

        return {
          creditsBalance: mergedUser.creditsBalance - 1,
          storagePath,
          alreadyUnlocked: false,
        }
      })

      const downloadUrl = await getArtifactDownloadUrl(result.storagePath)
      res.status(200).json({
        creditsBalance: result.creditsBalance,
        unlockStatus: 'unlocked',
        alreadyUnlocked: result.alreadyUnlocked,
        downloadUrl,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('consumeUnlockCredit failed', message)
      sendJsonError(res, 500, message)
    }
  }
)

export const deleteAccountArtifact = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    cors: true,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      sendJsonError(res, 405, 'method not allowed')
      return
    }

    try {
      const user = await authenticateRequest(req)
      await ensureUserDoc(user)

      const body = parseJsonRecord(req.body) as DeleteAccountArtifactRequest
      const artifactId = getString(body.artifactId)
      if (!artifactId) {
        sendJsonError(res, 400, 'artifactId is required.')
        return
      }

      const artifactRef = getArtifactRef(user.uid, artifactId)
      const artifactSnapshot = await artifactRef.get()
      if (!artifactSnapshot.exists) {
        sendJsonError(res, 404, 'Artifact not found for this account.')
        return
      }

      const artifactData = artifactSnapshot.data() as JsonMap
      const storagePath = getString(artifactData.storagePath)
      if (storagePath) {
        try {
          await adminStorage.bucket().file(storagePath).delete({ ignoreNotFound: true })
        } catch (error) {
          const code = typeof (error as { code?: unknown })?.code === 'number'
            ? (error as { code: number }).code
            : null
          if (code !== 404) {
            throw error
          }
        }
      }

      await artifactRef.delete()
      res.status(200).json({ artifactId, deleted: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('deleteAccountArtifact failed', message)
      sendJsonError(res, 500, message)
    }
  }
)

export const loadAccountArtifactBytes = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 120,
    cors: true,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      sendJsonError(res, 405, 'method not allowed')
      return
    }

    try {
      const user = await authenticateRequest(req)
      const body = parseJsonRecord(req.body) as LoadAccountArtifactBytesRequest
      const artifactId = getString(body.artifactId)
      if (!artifactId) {
        sendJsonError(res, 400, 'artifactId is required.')
        return
      }

      const artifactRef = getArtifactRef(user.uid, artifactId)
      const artifactSnapshot = await artifactRef.get()
      if (!artifactSnapshot.exists) {
        sendJsonError(res, 404, 'Artifact not found for this account.')
        return
      }

      const artifactData = artifactSnapshot.data() as JsonMap
      if (getString(artifactData.unlockStatus) !== 'unlocked') {
        sendJsonError(res, 403, 'Artifact must be unlocked before loading preview bytes.')
        return
      }

      const storagePath = getString(artifactData.storagePath)
      if (!storagePath) {
        throw new Error('Artifact storage path is missing.')
      }

      const outputName = getString(artifactData.outputName) || path.basename(storagePath)
      const sha256 = getString(artifactData.sha256) || ''
      const bytes = await readStorageBytes(storagePath)

      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Access-Control-Expose-Headers', LOAD_ACCOUNT_ARTIFACT_EXPOSE_HEADERS)
      res.setHeader('X-Output-Name', outputName)
      res.setHeader('X-Bytes-Length', String(bytes.byteLength))
      if (sha256) {
        res.setHeader('X-Sha256', sha256)
      }
      res.send(Buffer.from(bytes))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('loadAccountArtifactBytes failed', message)
      sendJsonError(res, 500, message)
    }
  }
)

export const lemonsqueezyWebhook = onRequest(
  {
    region: FUNCTION_REGION,
    timeoutSeconds: 60,
    cors: false,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      sendJsonError(res, 405, 'method not allowed')
      return
    }

    try {
      const rawBody = req.rawBody
      if (!rawBody || rawBody.length === 0) {
        throw new Error('Missing raw webhook body.')
      }

      if (!verifyWebhookSignature(rawBody, req.headers['x-signature'] as string | undefined)) {
        sendJsonError(res, 401, 'Invalid webhook signature.')
        return
      }

      const eventId = deriveWebhookEventId(rawBody)
      const eventRef = billingEventsCollection.doc(eventId)
      const existingEvent = await eventRef.get()
      if (existingEvent.exists) {
        res.status(200).json({ ok: true, duplicate: true })
        return
      }

      const payload = parseJsonRecord(req.body)
      const meta = isRecord(payload.meta) ? payload.meta : {}
      const eventName = getString(meta.event_name)
      if (!eventName) {
        throw new Error('Webhook payload is missing meta.event_name.')
      }

      if (eventName !== 'order_created' && eventName !== 'order_refunded') {
        await eventRef.set({
          provider: BILLING_PROVIDER,
          eventId,
          eventType: eventName,
          processedAt: FieldValue.serverTimestamp(),
          userId: null,
          orderId: null,
          note: 'Ignored unsupported Lemon Squeezy webhook event.',
        })
        res.status(200).json({ ok: true, skipped: true })
        return
      }

      const identifiers = extractOrderIdentifiers(payload)
      const orderId = identifiers.orderId
      if (!orderId) {
        throw new Error('Webhook payload is missing an order id.')
      }

      if (eventName === 'order_created') {
        const pack =
          getCreditPackById(identifiers.packId) ||
          getConfiguredCreditPackByVariantId(identifiers.variantId)
        if (!pack) {
          await eventRef.set({
            provider: BILLING_PROVIDER,
            eventId,
            eventType: eventName,
            processedAt: FieldValue.serverTimestamp(),
            userId: identifiers.uid ?? null,
            orderId,
            note: 'No matching credit pack found for webhook payload.',
          })
          res.status(202).json({ ok: true, skipped: true })
          return
        }

        const userRef = await getUserDocByIdentifiers({
          uid: identifiers.uid ?? null,
          customerId: identifiers.customerId ?? null,
        })
        if (!userRef) {
          await eventRef.set({
            provider: BILLING_PROVIDER,
            eventId,
            eventType: eventName,
            processedAt: FieldValue.serverTimestamp(),
            userId: identifiers.uid ?? null,
            orderId,
            note: 'No matching user found for credit-pack order.',
          })
          res.status(202).json({ ok: true, skipped: true })
          return
        }

        const orderRef = creditOrdersCollection.doc(orderId)
        await adminDb.runTransaction(async (transaction) => {
          const [userSnapshot, orderSnapshot] = await Promise.all([
            transaction.get(userRef),
            transaction.get(orderRef),
          ])

          if (orderSnapshot.exists && getString(orderSnapshot.data()?.status) === 'paid') {
            return
          }

          const userData = mergeUserDoc(
            {
              uid: userRef.id,
              email: getString((userSnapshot.data() as JsonMap | undefined)?.email),
              displayName: getString((userSnapshot.data() as JsonMap | undefined)?.displayName),
              photoURL: getString((userSnapshot.data() as JsonMap | undefined)?.photoURL),
            },
            userSnapshot.data() as JsonMap | undefined
          )

          const nextUserDoc: UserDocShape = {
            ...userData,
            creditsBalance: userData.creditsBalance + pack.credits,
            lifetimeCreditsPurchased: userData.lifetimeCreditsPurchased + pack.credits,
            lemonsqueezyCustomerId: identifiers.customerId || userData.lemonsqueezyCustomerId,
            lastCreditGrantOrderId: orderId,
            lastCreditGrantAt: new Date().toISOString(),
          }

          const orderDoc: CreditOrderDocShape = {
            orderId,
            uid: userRef.id,
            packId: pack.packId,
            variantId: identifiers.variantId || getConfiguredCreditPackById(pack.packId)?.variantId || '',
            creditsGranted: pack.credits,
            status: 'paid',
            lemonsqueezyCustomerId: identifiers.customerId ?? userData.lemonsqueezyCustomerId,
            refundedAt: null,
          }

          transaction.set(
            userRef,
            userDocWrite(nextUserDoc, { includeCreatedAt: !userSnapshot.exists }),
            { merge: true }
          )
          transaction.set(
            orderRef,
            {
              ...orderDoc,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
        })

        await eventRef.set({
          provider: BILLING_PROVIDER,
          eventId,
          eventType: eventName,
          processedAt: FieldValue.serverTimestamp(),
          userId: userRef.id,
          orderId,
        })

        res.status(200).json({ ok: true })
        return
      }

      const orderRef = creditOrdersCollection.doc(orderId)
      const orderSnapshot = await orderRef.get()
      if (!orderSnapshot.exists) {
        await eventRef.set({
          provider: BILLING_PROVIDER,
          eventId,
          eventType: eventName,
          processedAt: FieldValue.serverTimestamp(),
          userId: identifiers.uid ?? null,
          orderId,
          note: 'Refund received for unknown credit order.',
        })
        res.status(200).json({ ok: true, skipped: true })
        return
      }

      const orderData = orderSnapshot.data() as JsonMap | undefined
      if (getString(orderData?.status) === 'refunded') {
        await eventRef.set({
          provider: BILLING_PROVIDER,
          eventId,
          eventType: eventName,
          processedAt: FieldValue.serverTimestamp(),
          userId: getString(orderData?.uid),
          orderId,
          note: 'Credit order already refunded.',
        })
        res.status(200).json({ ok: true, duplicate: true })
        return
      }

      const orderUserId = getString(orderData?.uid)
      if (!orderUserId) {
        await eventRef.set({
          provider: BILLING_PROVIDER,
          eventId,
          eventType: eventName,
          processedAt: FieldValue.serverTimestamp(),
          userId: null,
          orderId,
          note: 'Credit order is missing uid for refund handling.',
        })
        res.status(200).json({ ok: true, skipped: true })
        return
      }

      const userRef = usersCollection.doc(orderUserId)
      const userSnapshot = await userRef.get()
      const userData = mergeUserDoc(
        {
          uid: userRef.id,
          email: getString((userSnapshot.data() as JsonMap | undefined)?.email),
          displayName: getString((userSnapshot.data() as JsonMap | undefined)?.displayName),
          photoURL: getString((userSnapshot.data() as JsonMap | undefined)?.photoURL),
        },
        userSnapshot.data() as JsonMap | undefined
      )

      const creditsGrantedRaw = typeof orderData?.creditsGranted === 'number' ? orderData.creditsGranted : 0
      const creditsGranted = Number.isFinite(creditsGrantedRaw) ? Math.max(0, Math.trunc(creditsGrantedRaw)) : 0

      await adminDb.runTransaction(async (transaction) => {
        transaction.set(
          userRef,
          userDocWrite({
            ...userData,
            creditsBalance: userData.creditsBalance - creditsGranted,
          }),
          { merge: true }
        )
        transaction.set(
          orderRef,
          {
            status: 'refunded',
            refundedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      })

      await eventRef.set({
        provider: BILLING_PROVIDER,
        eventId,
        eventType: eventName,
        processedAt: FieldValue.serverTimestamp(),
        userId: userRef.id,
        orderId,
      })

      res.status(200).json({ ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('lemonsqueezyWebhook failed', message)
      sendJsonError(res, 500, message)
    }
  }
)
