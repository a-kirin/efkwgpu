import type firebaseCompat from 'firebase/compat/app'
import firebase, { firebaseApp, firebaseAuth, firebaseDb } from './firebase'

export type CreditPackId = 'starter_10' | 'value_40'

export type AuthUserRecord = {
  uid: string
  email: string | null
  displayName: string
  photoURL: string | null
  avatarSeed: string
}

export type AccountUserRecord = AuthUserRecord & {
  creditsBalance: number
  availableCredits: number
  freePreviewConversionsUsed: number
  lifetimeCreditsPurchased: number
  lifetimeCreditsSpent: number
  lastCreditGrantOrderId: string | null
  lastCreditGrantAt: string | null
}

export type AccountArtifactRecord = {
  artifactId: string
  outputName: string
  displayName: string
  bytesLength: number
  sha256: string
  sourceName: string
  unlockStatus: 'locked' | 'unlocked'
  unlockedAt: string | null
  createdAt: string | null
}

export type AccountState = {
  authUser: AuthUserRecord | null
  account: AccountUserRecord | null
  artifacts: AccountArtifactRecord[]
}

export type RegisterArtifactResult = {
  artifactId: string
  alreadyExisted: boolean
  sha256: string
  bytesLength: number
}

export type ConsumeUnlockResult = {
  creditsBalance: number
  unlockStatus: 'unlocked'
  alreadyUnlocked: boolean
  downloadUrl: string
}

export type StartEffectConversionResult = {
  artifactId?: string
  alreadyExisted: boolean
  bytes: Uint8Array
  outputName: string
  mainEffectPath: string
  bytesLength: number
  sha256: string
  status: 'completed'
}

export class FunctionApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly purchaseRequired?: boolean

  constructor(
    message: string,
    options: {
      status: number
      code?: string
      purchaseRequired?: boolean
    }
  ) {
    super(message)
    this.name = 'FunctionApiError'
    this.status = options.status
    this.code = options.code
    this.purchaseRequired = options.purchaseRequired
  }
}

const USERS_COLLECTION = 'users'
const ARTIFACTS_COLLECTION = 'artifacts'
const FUNCTIONS_REGION = import.meta.env.VITE_FUNCTIONS_REGION || 'us-central1'
const FUNCTIONS_BASE_URL = (import.meta.env.VITE_FUNCTIONS_BASE_URL || '').trim()
const FUNCTION_URLS = {
  createCreditPackCheckoutSession:
    (import.meta.env.VITE_CREATE_CREDIT_PACK_CHECKOUT_SESSION_URL || '').trim() ||
    (import.meta.env.VITE_CREATE_SUBSCRIPTION_CHECKOUT_SESSION_URL || '').trim(),
  startEffectConversion: (import.meta.env.VITE_START_EFFECT_CONVERSION_URL || '').trim(),
  registerConvertedArtifact: (import.meta.env.VITE_REGISTER_CONVERTED_ARTIFACT_URL || '').trim(),
  consumeUnlockCredit: (import.meta.env.VITE_CONSUME_UNLOCK_CREDIT_URL || '').trim(),
  loadAccountArtifactBytes: (import.meta.env.VITE_LOAD_ACCOUNT_ARTIFACT_BYTES_URL || '').trim(),
  deleteAccountArtifact: (import.meta.env.VITE_DELETE_ACCOUNT_ARTIFACT_URL || '').trim(),
} as const

let redirectResolutionStarted = false

const ensureRedirectResolution = () => {
  if (redirectResolutionStarted) return
  redirectResolutionStarted = true
  void firebaseAuth.getRedirectResult().catch(() => {
    // Auth state listener is the source of truth. Ignore redirect completion failures here.
  })
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

const hexFromBytes = (bytes: Uint8Array): string => (
  Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('')
)

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const payload = new Uint8Array(bytes.byteLength)
  payload.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', payload.buffer as ArrayBuffer)
  return hexFromBytes(new Uint8Array(digest))
}

const getFunctionUrl = (name: string): string => {
  const explicitUrl = FUNCTION_URLS[name as keyof typeof FUNCTION_URLS]
  if (explicitUrl) {
    return explicitUrl
  }

  if (FUNCTIONS_BASE_URL) {
    return `${FUNCTIONS_BASE_URL.replace(/\/$/, '')}/${name}`
  }

  const projectId = (firebaseApp.options as { projectId?: string }).projectId
  if (!projectId) {
    throw new Error('Firebase projectId is missing from client config.')
  }

  return `https://${FUNCTIONS_REGION}-${projectId}.cloudfunctions.net/${name}`
}

const sanitizeTimestamp = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString()
    } catch {
      return null
    }
  }
  return null
}

const sanitizeAuthUser = (user: firebaseCompat.User): AuthUserRecord => ({
  uid: user.uid,
  email: typeof user.email === 'string' ? user.email : null,
  displayName: typeof user.displayName === 'string' && user.displayName.trim() ? user.displayName.trim() : 'User',
  photoURL: typeof user.photoURL === 'string' && user.photoURL.trim() ? user.photoURL : null,
  avatarSeed:
    (typeof user.email === 'string' && user.email.split('@')[0]?.trim()) ||
    (typeof user.displayName === 'string' && user.displayName.trim()) ||
    user.uid.slice(0, 24),
})

const sanitizeAccountUser = (
  authUser: AuthUserRecord,
  raw: Record<string, unknown> | undefined
): AccountUserRecord => {
  const creditsBalance = typeof raw?.creditsBalance === 'number' ? Math.trunc(raw.creditsBalance) : 0
  const freePreviewConversionsUsed = typeof raw?.freePreviewConversionsUsed === 'number'
    ? Math.max(0, Math.trunc(raw.freePreviewConversionsUsed))
    : 0
  const lifetimeCreditsPurchased = typeof raw?.lifetimeCreditsPurchased === 'number'
    ? Math.max(0, Math.trunc(raw.lifetimeCreditsPurchased))
    : 0
  const lifetimeCreditsSpent = typeof raw?.lifetimeCreditsSpent === 'number'
    ? Math.max(0, Math.trunc(raw.lifetimeCreditsSpent))
    : 0

  return {
    ...authUser,
    displayName:
      typeof raw?.displayName === 'string' && raw.displayName.trim()
        ? raw.displayName.trim()
        : authUser.displayName,
    photoURL:
      typeof raw?.photoURL === 'string' && raw.photoURL.trim()
        ? raw.photoURL
        : authUser.photoURL,
    avatarSeed:
      typeof raw?.avatarSeed === 'string' && raw.avatarSeed.trim()
        ? raw.avatarSeed.trim()
        : authUser.avatarSeed,
    creditsBalance: Number.isFinite(creditsBalance) ? creditsBalance : 0,
    availableCredits: Number.isFinite(creditsBalance) ? Math.max(0, creditsBalance) : 0,
    freePreviewConversionsUsed,
    lifetimeCreditsPurchased,
    lifetimeCreditsSpent,
    lastCreditGrantOrderId:
      typeof raw?.lastCreditGrantOrderId === 'string' && raw.lastCreditGrantOrderId.trim()
        ? raw.lastCreditGrantOrderId
        : null,
    lastCreditGrantAt: sanitizeTimestamp(raw?.lastCreditGrantAt),
  }
}

const sanitizeAccountArtifact = (
  snapshot: firebaseCompat.firestore.QueryDocumentSnapshot<firebaseCompat.firestore.DocumentData>
): AccountArtifactRecord | null => {
  const raw = snapshot.data() as Record<string, unknown> | undefined
  const artifactId = typeof raw?.artifactId === 'string' && raw.artifactId ? raw.artifactId : snapshot.id
  const outputName = typeof raw?.outputName === 'string' && raw.outputName ? raw.outputName : ''
  if (!outputName) return null

  return {
    artifactId,
    outputName,
    displayName:
      typeof raw?.displayName === 'string' && raw.displayName.trim()
        ? raw.displayName.trim()
        : outputName,
    bytesLength:
      typeof raw?.bytesLength === 'number' && Number.isFinite(raw.bytesLength)
        ? Math.max(0, Math.floor(raw.bytesLength))
        : 0,
    sha256: typeof raw?.sha256 === 'string' ? raw.sha256 : '',
    sourceName: typeof raw?.sourceName === 'string' ? raw.sourceName : '',
    unlockStatus: raw?.unlockStatus === 'unlocked' ? 'unlocked' : 'locked',
    unlockedAt: sanitizeTimestamp(raw?.unlockedAt),
    createdAt: sanitizeTimestamp(raw?.createdAt),
  }
}

const getCurrentUserIdToken = async (): Promise<string> => {
  const user = firebaseAuth.currentUser
  if (!user) {
    throw new Error('Sign-in is required.')
  }
  return user.getIdToken()
}

const isLocalFunctionUrl = (name: string): boolean => {
  try {
    const url = new URL(getFunctionUrl(name), window.location.origin)
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  } catch {
    return false
  }
}

export const usesLocalStartEffectConversion = (): boolean => isLocalFunctionUrl('startEffectConversion')

const parseStartEffectConversionBinaryResponse = async (
  name: string,
  response: Response
): Promise<StartEffectConversionResult> => {
  if (!response.ok) {
    return parseJsonResponse<StartEffectConversionResult>(name, response)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const outputName = response.headers.get('X-Output-Name')?.trim() || ''
  const mainEffectPath = response.headers.get('X-Main-Effect-Path')?.trim() || ''
  const sha256 = response.headers.get('X-Sha256')?.trim() || ''
  const artifactId = response.headers.get('X-Artifact-Id')?.trim() || undefined
  const status = response.headers.get('X-Status')?.trim() || ''
  const bytesLengthHeader = response.headers.get('X-Bytes-Length')?.trim() || ''
  const alreadyExistedHeader = response.headers.get('X-Already-Existed')?.trim() || '0'
  const bytesLength = Number.parseInt(bytesLengthHeader, 10)

  if (!outputName) throw new Error('startEffectConversion did not return X-Output-Name.')
  if (!mainEffectPath) throw new Error('startEffectConversion did not return X-Main-Effect-Path.')
  if (!sha256) throw new Error('startEffectConversion did not return X-Sha256.')
  if (!Number.isFinite(bytesLength) || bytesLength <= 0) {
    throw new Error('startEffectConversion did not return a valid X-Bytes-Length.')
  }
  if (status !== 'completed') {
    throw new Error('startEffectConversion returned an unexpected X-Status.')
  }

  return {
    artifactId,
    alreadyExisted: alreadyExistedHeader === '1',
    bytes,
    outputName,
    mainEffectPath,
    bytesLength,
    sha256,
    status: 'completed',
  }
}

const parseJsonResponse = async <TResponse>(name: string, response: Response): Promise<TResponse> => {
  const text = await response.text()
  let data: Record<string, unknown> = {}
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new Error(`Invalid JSON returned by ${name}: ${text.slice(0, 200)}`)
    }
  }

  if (!response.ok) {
    const message = typeof data.error === 'string' && data.error ? data.error : `${name} failed with HTTP ${response.status}`
    throw new FunctionApiError(message, {
      status: response.status,
      code: typeof data.code === 'string' ? data.code : undefined,
      purchaseRequired: data.purchaseRequired === true,
    })
  }

  return data as TResponse
}

const callAuthedJson = async <TResponse>(name: string, payload: Record<string, unknown>): Promise<TResponse> => {
  const token = await getCurrentUserIdToken()
  const response = await fetch(getFunctionUrl(name), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  })

  return parseJsonResponse<TResponse>(name, response)
}

const callAuthedBinary = async (
  name: string,
  payload: Record<string, unknown>
): Promise<{
  bytes: Uint8Array
  outputName: string
  sha256: string
  bytesLength: number
}> => {
  const token = await getCurrentUserIdToken()
  const response = await fetch(getFunctionUrl(name), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    await parseJsonResponse(name, response)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const outputName = response.headers.get('X-Output-Name')?.trim() || ''
  const sha256 = response.headers.get('X-Sha256')?.trim() || ''
  const bytesLengthHeader = response.headers.get('X-Bytes-Length')?.trim() || ''
  const bytesLength = Number.parseInt(bytesLengthHeader, 10)

  if (!outputName) throw new Error(`${name} did not return X-Output-Name.`)
  if (!Number.isFinite(bytesLength) || bytesLength < 0) {
    throw new Error(`${name} did not return a valid X-Bytes-Length.`)
  }

  return {
    bytes,
    outputName,
    sha256,
    bytesLength,
  }
}

export function subscribeToAccountState(
  onState: (state: AccountState) => void,
  onError: (message: string) => void
) {
  ensureRedirectResolution()

  let unsubscribeUserDoc = () => {}
  let unsubscribeArtifacts = () => {}
  let latestArtifacts: AccountArtifactRecord[] = []
  let latestAccount: AccountUserRecord | null = null

  const emitState = (authUser: AuthUserRecord | null, account: AccountUserRecord | null) => {
    latestAccount = account
    onState({
      authUser,
      account,
      artifacts: account ? latestArtifacts : [],
    })
  }

  const unsubscribeAuth = firebaseAuth.onAuthStateChanged((user) => {
    unsubscribeUserDoc()
    unsubscribeUserDoc = () => {}
    unsubscribeArtifacts()
    unsubscribeArtifacts = () => {}
    latestArtifacts = []

    if (!user) {
      emitState(null, null)
      return
    }

    const authUser = sanitizeAuthUser(user)
    emitState(authUser, sanitizeAccountUser(authUser, undefined))

    const userRef = firebaseDb.collection(USERS_COLLECTION).doc(user.uid)
    unsubscribeUserDoc = userRef.onSnapshot(
      (snapshot) => {
        const account = sanitizeAccountUser(authUser, snapshot.data() as Record<string, unknown> | undefined)
        emitState(authUser, account)
      },
      (error) => {
        onError(`Account sync failed: ${error.message}`)
      }
    )

    unsubscribeArtifacts = userRef
      .collection(ARTIFACTS_COLLECTION)
      .orderBy('createdAt', 'desc')
      .onSnapshot(
        (snapshot) => {
          latestArtifacts = snapshot.docs
            .map((doc) => sanitizeAccountArtifact(doc))
            .filter((item): item is AccountArtifactRecord => item !== null)
          emitState(authUser, latestAccount || sanitizeAccountUser(authUser, undefined))
        },
        (error) => {
          onError(`Artifact sync failed: ${error.message}`)
        }
      )
  })

  return () => {
    unsubscribeUserDoc()
    unsubscribeArtifacts()
    unsubscribeAuth()
  }
}

export async function signInWithGoogle(): Promise<boolean> {
  ensureRedirectResolution()
  const provider = new firebase.auth.GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })

  try {
    await firebaseAuth.signInWithPopup(provider)
    return true
  } catch (error) {
    const code = (error as { code?: string }).code || ''
    if (code === 'auth/popup-blocked') {
      await firebaseAuth.signInWithRedirect(provider)
      return false
    }
    throw error
  }
}

export async function signOutCurrentUser(): Promise<void> {
  await firebaseAuth.signOut()
}

export async function getCurrentAccountSnapshot(): Promise<AccountUserRecord | null> {
  const user = firebaseAuth.currentUser
  if (!user) return null

  const authUser = sanitizeAuthUser(user)
  const snapshot = await firebaseDb.collection(USERS_COLLECTION).doc(user.uid).get()
  return sanitizeAccountUser(authUser, snapshot.data() as Record<string, unknown> | undefined)
}

export async function startEffectConversion(options: {
  sourceName: string
  sourceBytes: Uint8Array
  extraFiles?: Array<{
    name: string
    relativePath: string
    bytes: Uint8Array
  }>
}): Promise<StartEffectConversionResult> {
  const form = new FormData()
  const sourcePayload = new Uint8Array(options.sourceBytes.byteLength)
  sourcePayload.set(options.sourceBytes)
  form.append('manifest', JSON.stringify({
    sourceName: options.sourceName,
    extraFiles: (options.extraFiles ?? []).map((entry, index) => ({
      fieldName: `dep${index}`,
      name: entry.name,
      relativePath: entry.relativePath,
    })),
  }))
  form.append('source', new File([sourcePayload.buffer], options.sourceName, { type: 'application/octet-stream' }))
  for (const [index, entry] of (options.extraFiles ?? []).entries()) {
    const dependencyPayload = new Uint8Array(entry.bytes.byteLength)
    dependencyPayload.set(entry.bytes)
    form.append(`dep${index}`, new File([dependencyPayload.buffer], entry.name, { type: 'application/octet-stream' }))
  }

  const headers: HeadersInit = {}
  if (!isLocalFunctionUrl('startEffectConversion')) {
    const token = await getCurrentUserIdToken()
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(getFunctionUrl('startEffectConversion'), {
    method: 'POST',
    headers,
    body: form,
  })

  return parseStartEffectConversionBinaryResponse('startEffectConversion', response)
}

export async function registerConvertedArtifact(options: {
  outputName: string
  sourceName: string
  bytes: Uint8Array
}): Promise<RegisterArtifactResult> {
  const sha256 = await sha256Hex(options.bytes)
  const bytesLength = options.bytes.byteLength
  const result = await callAuthedJson<{ artifactId: string; alreadyExisted: boolean }>('registerConvertedArtifact', {
    outputName: options.outputName,
    sourceName: options.sourceName,
    bytesBase64: bytesToBase64(options.bytes),
    sha256,
    bytesLength,
  })

  return {
    artifactId: result.artifactId,
    alreadyExisted: result.alreadyExisted,
    sha256,
    bytesLength,
  }
}

export async function consumeUnlockCredit(artifactId: string): Promise<ConsumeUnlockResult> {
  return callAuthedJson<ConsumeUnlockResult>('consumeUnlockCredit', { artifactId })
}

export async function loadAccountArtifactBytes(artifactId: string): Promise<{
  bytes: Uint8Array
  outputName: string
  sha256: string
  bytesLength: number
}> {
  return callAuthedBinary('loadAccountArtifactBytes', { artifactId })
}

export async function deleteAccountArtifact(artifactId: string): Promise<void> {
  await callAuthedJson<{ deleted: boolean }>('deleteAccountArtifact', { artifactId })
}

export async function createCreditPackCheckoutSession(options: {
  packId: CreditPackId
  returnUrl: string
  artifactId?: string
}): Promise<{ checkoutUrl: string }> {
  return callAuthedJson<{ checkoutUrl: string }>('createCreditPackCheckoutSession', options)
}
