import effectUrl from './pkmoves/blood.efkwgpk?url'

type EffekseerHandle = {
  stop(): void
}

type EffekseerContext = {
  init(
    target: HTMLCanvasElement | string,
    settings?: {
      instanceMaxCount?: number
      squareMaxCount?: number
      linearColorSpace?: boolean
    }
  ): boolean
  registerEffects(
    effects: Record<string, string | { path: string; scale?: number; enabled?: boolean }>
  ): void
  whenEffectsReady(ids?: string[] | string): Promise<Map<string, unknown | null>>
  playEffect(id: string, x?: number, y?: number, z?: number): EffekseerHandle | null
  update(deltaFrames?: number): void
  draw(): void
  stopAll(): void
  setProjectionPerspective?(fov: number, aspect: number, near: number, far: number): void
  setCameraLookAt?(
    positionX: number,
    positionY: number,
    positionZ: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    upvecX: number,
    upvecY: number,
    upvecZ: number
  ): void
}

type EffekseerApi = {
  initRuntime(path: string): Promise<void>
  createContext(): EffekseerContext | null
  releaseContext(context: EffekseerContext | null): void
}

type EffekseerStatsContext = EffekseerContext & {
  getRestInstancesCount?(): number
  getUpdateTime?(): number
  getDrawTime?(): number
  getDrawFlushComputeTime?(): number
  getDrawBeginFrameTime?(): number
  getDrawManagerTime?(): number
  getDrawEndFrameTime?(): number
  getDrawTotalTime?(): number
  getGpuTimestampSupported?(): boolean
  getGpuTimestampValid?(): boolean
  getGpuTimestampEffekseerPassTime?(): number
  getGpuTimestampFrameTime?(): number
  getRendererProfileBindGroupTime?(): number
  getRendererProfilePipelineTime?(): number
  getRendererProfileSetStateTime?(): number
  getRendererProfileIssueDrawTime?(): number
  getRendererProfileDrawTotalTime?(): number
  getRendererProfileDrawSpritesCalls?(): number
  getRendererProfileDrawPolygonCalls?(): number
  getInternalStandardRendererTextureSetupTime?(): number
  getInternalStandardRendererShaderSelectTime?(): number
  getInternalStandardRendererVertexPackTime?(): number
  getInternalStandardRendererPixelPackTime?(): number
  getInternalStandardRendererConstantUploadTime?(): number
  getInternalStandardRendererRenderStateTime?(): number
  getInternalStandardRendererVertexBindTime?(): number
  getInternalStandardRendererIndexBindTime?(): number
  getInternalStandardRendererLayoutTime?(): number
  getInternalStandardRendererDrawTime?(): number
  getManagerProfileFrustumTime?(): number
  getManagerProfileSortTime?(): number
  getManagerProfileCanDrawTime?(): number
  getManagerProfileContainerDrawTime?(): number
  getManagerProfileGpuParticleTime?(): number
  getManagerProfileDrawSetCount?(): number
  getManagerProfileVisibleDrawSetCount?(): number
  getManagerProfileContainersTotal?(): number
  getManagerProfileContainersDrawn?(): number
  getManagerProfileContainersDepthCulled?(): number
  getDrawCallCount?(): number
  getDrawVertexCount?(): number
  getTotalParticleCount?(): number
}

function setHud(message: string): void {
  const hud = document.getElementById('hud')
  if (hud) {
    hud.textContent = message
  }
}

function usToMs(value?: number): number {
  return Number(value || 0) / 1000
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!ok) {
    throw new Error('Clipboard copy failed')
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('viewer-canvas')
  const effekseer = (window as typeof window & { effekseer?: EffekseerApi }).effekseer

  if (!(canvas instanceof HTMLCanvasElement) || !('gpu' in navigator) || !effekseer) {
    setHud('WebGPU runtime not available.')
    return
  }

  let cancelled = false
  let handle: EffekseerHandle | null = null
  const diagState = {
    frameCount: 0,
    slowFrames: 0,
    startedAt: performance.now(),
    lastFrameAt: performance.now(),
    fpsSmoothed: 0,
    frameMsSmoothed: 0,
    jsUpdateMsSmoothed: 0,
    jsDrawMsSmoothed: 0,
    effUpdateMsSmoothed: 0,
    effDrawMsSmoothed: 0,
    cssW: 0,
    cssH: 0,
    dpr: 1,
    maxFrameMs: 0,
    maxFrameAtSec: 0,
    maxFrameNumber: 0,
    maxFrameTable: '',
    latestTable: '',
    copyStatus: 'none',
  }

  const resize = (ctx: EffekseerContext) => {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const cssWidth = Math.max(1, Math.floor(canvas.clientWidth))
    const cssHeight = Math.max(1, Math.floor(canvas.clientHeight))
    const width = Math.max(1, Math.floor(cssWidth * pixelRatio))
    const height = Math.max(1, Math.floor(cssHeight * pixelRatio))

    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    diagState.cssW = cssWidth
    diagState.cssH = cssHeight
    diagState.dpr = pixelRatio

    const aspect = Math.max(0.001, width / height)
    ctx.setProjectionPerspective?.(45, aspect, 0.1, 100)
    ctx.setCameraLookAt?.(9, 4.5, 9, 0, 1, 0, 0, 1, 0)
  }

  await effekseer.initRuntime('/effekseer-runtime/Effekseer_WebGPU_Runtime.wasm')
  if (cancelled) return

  const ctx = effekseer.createContext()
  if (!ctx?.init(canvas, {
    instanceMaxCount: 20000,
    squareMaxCount: 20000,
  })) {
    setHud('ctx.init() failed.')
    return
  }

  const cleanup = () => {
    cancelled = true
    window.removeEventListener('resize', onResize)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('beforeunload', cleanup)
    handle?.stop()
    ctx.stopAll()
    effekseer.releaseContext(ctx)
  }

  const onResize = () => resize(ctx)
  const onKeyDown = async (event: KeyboardEvent) => {
    if (event.key !== 'c' && event.key !== 'C') return

    if (!diagState.latestTable) return

    const nowSec = ((performance.now() - diagState.startedAt) / 1000).toFixed(2)
    const peakHeader = diagState.maxFrameTable
      ? `PEAK STALL\nframe: #${diagState.maxFrameNumber} @ ${diagState.maxFrameAtSec.toFixed(2)}s\n${diagState.maxFrameTable}\n`
      : 'PEAK STALL\nnot captured yet\n'
    const dump = `EFFEKSEER DEBUG TABLE DUMP\ncapturedAt: ${nowSec}s\n\nCURRENT\n${diagState.latestTable}\n\n${peakHeader}`

    try {
      await copyTextToClipboard(dump)
      diagState.copyStatus = `ok @ ${nowSec}s`
    } catch (error) {
      console.error(error)
      diagState.copyStatus = `failed @ ${nowSec}s`
    }
  }

  ctx.registerEffects({
    blood: {
      path: effectUrl,
      scale: 1,
    },
  })

  resize(ctx)

  const loadedEffects = await ctx.whenEffectsReady(['blood'])
  if (cancelled) return

  if (!loadedEffects.get('blood')) {
    setHud('blood failed to load.')
    cleanup()
    return
  }

  handle = ctx.playEffect('blood', 0, 0, 0)
  if (!handle) {
    setHud('playEffect("blood") returned null.')
    cleanup()
    return
  }

  const render = (time: number) => {
    if (cancelled) return

    const dtMs = Math.max(time - diagState.lastFrameAt, 0.001)
    diagState.lastFrameAt = time
    diagState.frameCount += 1
    if (dtMs > 25) diagState.slowFrames += 1

    const fpsInstant = 1000 / dtMs
    if (diagState.fpsSmoothed === 0) {
      diagState.fpsSmoothed = fpsInstant
      diagState.frameMsSmoothed = dtMs
    } else {
      const alpha = 0.1
      diagState.fpsSmoothed += (fpsInstant - diagState.fpsSmoothed) * alpha
      diagState.frameMsSmoothed += (dtMs - diagState.frameMsSmoothed) * alpha
    }

    const deltaFrames = Math.max(0, (dtMs / 1000) * 60)
    const tUpdateStart = performance.now()
    ctx.update(deltaFrames)
    const tUpdateEnd = performance.now()
    ctx.draw()
    const tDrawEnd = performance.now()
    const statsCtx = ctx as EffekseerStatsContext

    const jsUpdateMs = tUpdateEnd - tUpdateStart
    const jsDrawMs = tDrawEnd - tUpdateEnd
    const effUpdateMs = usToMs(statsCtx.getUpdateTime?.())
    const effDrawMs = usToMs(statsCtx.getDrawTime?.())
    const effDrawFlushMs = usToMs(statsCtx.getDrawFlushComputeTime?.())
    const effDrawBeginMs = usToMs(statsCtx.getDrawBeginFrameTime?.())
    const effDrawMgrMs = usToMs(statsCtx.getDrawManagerTime?.())
    const effDrawEndMs = usToMs(statsCtx.getDrawEndFrameTime?.())
    const effDrawTotalMs = usToMs(statsCtx.getDrawTotalTime?.())
    const gpuTsSupported = !!statsCtx.getGpuTimestampSupported?.()
    const gpuTsValid = !!statsCtx.getGpuTimestampValid?.()
    const gpuTsEffPassMs = usToMs(statsCtx.getGpuTimestampEffekseerPassTime?.())
    const gpuTsFrameMs = usToMs(statsCtx.getGpuTimestampFrameTime?.())
    const rBindMs = usToMs(statsCtx.getRendererProfileBindGroupTime?.())
    const rPipeMs = usToMs(statsCtx.getRendererProfilePipelineTime?.())
    const rStateMs = usToMs(statsCtx.getRendererProfileSetStateTime?.())
    const rIssueMs = usToMs(statsCtx.getRendererProfileIssueDrawTime?.())
    const rTotalMs = usToMs(statsCtx.getRendererProfileDrawTotalTime?.())
    const rSprites = statsCtx.getRendererProfileDrawSpritesCalls?.() ?? -1
    const rPolys = statsCtx.getRendererProfileDrawPolygonCalls?.() ?? -1
    const srTexMs = usToMs(statsCtx.getInternalStandardRendererTextureSetupTime?.())
    const srShaderMs = usToMs(statsCtx.getInternalStandardRendererShaderSelectTime?.())
    const srVsMs = usToMs(statsCtx.getInternalStandardRendererVertexPackTime?.())
    const srPsMs = usToMs(statsCtx.getInternalStandardRendererPixelPackTime?.())
    const srUploadMs = usToMs(statsCtx.getInternalStandardRendererConstantUploadTime?.())
    const srStateMs = usToMs(statsCtx.getInternalStandardRendererRenderStateTime?.())
    const srVbMs = usToMs(statsCtx.getInternalStandardRendererVertexBindTime?.())
    const srIbMs = usToMs(statsCtx.getInternalStandardRendererIndexBindTime?.())
    const srLayoutMs = usToMs(statsCtx.getInternalStandardRendererLayoutTime?.())
    const srDrawMs = usToMs(statsCtx.getInternalStandardRendererDrawTime?.())
    const mFrustumMs = usToMs(statsCtx.getManagerProfileFrustumTime?.())
    const mSortMs = usToMs(statsCtx.getManagerProfileSortTime?.())
    const mCanDrawMs = usToMs(statsCtx.getManagerProfileCanDrawTime?.())
    const mContainerDrawMs = usToMs(statsCtx.getManagerProfileContainerDrawTime?.())
    const mGpuPartMs = usToMs(statsCtx.getManagerProfileGpuParticleTime?.())
    const mDrawSets = statsCtx.getManagerProfileDrawSetCount?.() ?? -1
    const mVisibleSets = statsCtx.getManagerProfileVisibleDrawSetCount?.() ?? -1
    const mContainersTotal = statsCtx.getManagerProfileContainersTotal?.() ?? -1
    const mContainersDrawn = statsCtx.getManagerProfileContainersDrawn?.() ?? -1
    const mContainersDepthCull = statsCtx.getManagerProfileContainersDepthCulled?.() ?? -1
    const drawCalls = statsCtx.getDrawCallCount?.() ?? -1
    const drawVertices = statsCtx.getDrawVertexCount?.() ?? -1
    const particleCount = statsCtx.getTotalParticleCount?.() ?? -1
    const restInstances = statsCtx.getRestInstancesCount?.() ?? -1

    if (diagState.frameCount === 1) {
      diagState.jsUpdateMsSmoothed = jsUpdateMs
      diagState.jsDrawMsSmoothed = jsDrawMs
      diagState.effUpdateMsSmoothed = effUpdateMs
      diagState.effDrawMsSmoothed = effDrawMs
    } else {
      const alpha = 0.1
      diagState.jsUpdateMsSmoothed += (jsUpdateMs - diagState.jsUpdateMsSmoothed) * alpha
      diagState.jsDrawMsSmoothed += (jsDrawMs - diagState.jsDrawMsSmoothed) * alpha
      diagState.effUpdateMsSmoothed += (effUpdateMs - diagState.effUpdateMsSmoothed) * alpha
      diagState.effDrawMsSmoothed += (effDrawMs - diagState.effDrawMsSmoothed) * alpha
    }

    const elapsedSec = Math.max((time - diagState.startedAt) / 1000, 0.001)
    const fpsAvg = diagState.frameCount / elapsedSec

    const hudTable =
`DIAG (Canvas Only, no Three, no external pass)
FPS instant: ${fpsInstant.toFixed(1)}
FPS smooth:  ${diagState.fpsSmoothed.toFixed(1)}
FPS avg:     ${fpsAvg.toFixed(1)}
Frame ms:    ${diagState.frameMsSmoothed.toFixed(2)}
Slow frames: ${diagState.slowFrames} (>25ms)
Canvas CSS:  ${diagState.cssW}x${diagState.cssH} @ DPR ${diagState.dpr.toFixed(2)}
Render:      ${canvas.width}x${canvas.height}
Present:     fill window
Current:     drawCalls ${drawCalls} | vertices ${drawVertices} | particles ${particleCount}
Flags:       pause(P) OFF | draw(O) ON | fixed(F) OFF | effects 1
Update:      steps 1 | js ${jsUpdateMs.toFixed(2)} ms (sm ${diagState.jsUpdateMsSmoothed.toFixed(2)}) | acc 0.00 frames
Draw:        js ${jsDrawMs.toFixed(2)} ms (sm ${diagState.jsDrawMsSmoothed.toFixed(2)})
Draw split:  flush ${effDrawFlushMs.toFixed(2)} | begin ${effDrawBeginMs.toFixed(2)} | mgr ${effDrawMgrMs.toFixed(2)} | end ${effDrawEndMs.toFixed(2)} | total ${effDrawTotalMs.toFixed(2)}
GPU ts:      supported ${gpuTsSupported ? 'YES' : 'NO'} | valid ${gpuTsValid ? 'YES' : 'NO'} | effPass ${gpuTsEffPassMs.toFixed(2)} | frame ${gpuTsFrameMs.toFixed(2)}
Renderer:    bind ${rBindMs.toFixed(2)} | pipe ${rPipeMs.toFixed(2)} | state ${rStateMs.toFixed(2)} | issue ${rIssueMs.toFixed(2)} | total ${rTotalMs.toFixed(2)}
Renderer2:   spriteCalls ${rSprites} | polyCalls ${rPolys}
StdRender:   tex ${srTexMs.toFixed(2)} | shader ${srShaderMs.toFixed(2)} | vs ${srVsMs.toFixed(2)} | ps ${srPsMs.toFixed(2)} | upload ${srUploadMs.toFixed(2)}
StdRender2:  state ${srStateMs.toFixed(2)} | vb ${srVbMs.toFixed(2)} | ib ${srIbMs.toFixed(2)} | layout ${srLayoutMs.toFixed(2)} | draw ${srDrawMs.toFixed(2)}
Manager:     frustum ${mFrustumMs.toFixed(2)} | sort ${mSortMs.toFixed(2)} | canDraw ${mCanDrawMs.toFixed(2)} | contDraw ${mContainerDrawMs.toFixed(2)} | gpuPart ${mGpuPartMs.toFixed(2)}
Manager2:    drawSets ${mDrawSets} | visible ${mVisibleSets} | containers total ${mContainersTotal} drawn ${mContainersDrawn} depthCull ${mContainersDepthCull}
Peak stall:  ${diagState.maxFrameMs.toFixed(2)} ms @ ${diagState.maxFrameAtSec.toFixed(2)}s (frame #${diagState.maxFrameNumber || 0})
Controls:    C copy full table (current + peak)
Copy:        ${diagState.copyStatus}
Effekseer:   update ${effUpdateMs.toFixed(2)} ms (sm ${diagState.effUpdateMsSmoothed.toFixed(2)}) | draw ${effDrawMs.toFixed(2)} ms (sm ${diagState.effDrawMsSmoothed.toFixed(2)}) | rest ${restInstances}`

    diagState.latestTable = hudTable
    if (dtMs >= diagState.maxFrameMs) {
      diagState.maxFrameMs = dtMs
      diagState.maxFrameAtSec = elapsedSec
      diagState.maxFrameNumber = diagState.frameCount
      diagState.maxFrameTable = hudTable
    }

    setHud(hudTable)

    window.requestAnimationFrame(render)
  }

  window.addEventListener('resize', onResize)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('beforeunload', cleanup)
  window.requestAnimationFrame(render)
}

void main().catch((error: unknown) => {
  console.error(error)
  setHud(String(error))
})
