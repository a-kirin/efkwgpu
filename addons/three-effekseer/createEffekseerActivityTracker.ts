import type { EffekseerContext, EffekseerHandle } from './effekseer-webgpu-types'

type TrackerState = {
  trackedHandles: Set<EffekseerHandle>
  wrappedHandles: WeakSet<EffekseerHandle>
  refCount: number
  bootstrapFramesRemaining: number
  lastObservedRuntimeActive: boolean
  originalPlayEffect: EffekseerContext['playEffect']
  wrappedPlayEffect: EffekseerContext['playEffect']
  originalPlay: EffekseerContext['play'] | undefined
  wrappedPlay: EffekseerContext['play'] | undefined
  originalStopAll: EffekseerContext['stopAll']
  wrappedStopAll: EffekseerContext['stopAll']
}

export type EffekseerActivityTracker = {
  beforeFrame(): boolean
  afterFrame(): void
  dispose(): void
}

const trackerStates = new WeakMap<EffekseerContext, TrackerState>()

function isHandleAlive(handle: EffekseerHandle | null | undefined): boolean {
  if (!handle) return false
  return handle.exists !== false
}

function wrapHandleStop(state: TrackerState, handle: EffekseerHandle): void {
  if (state.wrappedHandles.has(handle)) {
    return
  }

  state.wrappedHandles.add(handle)

  const originalStop = handle.stop
  handle.stop = (() => {
    try {
      return originalStop.call(handle)
    } finally {
      state.trackedHandles.delete(handle)
      state.lastObservedRuntimeActive = state.trackedHandles.size > 0
    }
  }) as EffekseerHandle['stop']
}

function trackHandle(state: TrackerState, handle: EffekseerHandle | null): EffekseerHandle | null {
  if (!handle) {
    return null
  }

  state.trackedHandles.add(handle)
  state.lastObservedRuntimeActive = true
  wrapHandleStop(state, handle)
  return handle
}

function sweepInactiveHandles(state: TrackerState): void {
  for (const handle of state.trackedHandles) {
    if (!isHandleAlive(handle)) {
      state.trackedHandles.delete(handle)
    }
  }
}

function resolveRuntimeActivity(effekseer: EffekseerContext): boolean | null {
  if (typeof effekseer.getTotalParticleCount === 'function') {
    return effekseer.getTotalParticleCount() > 0
  }

  if (typeof effekseer.getManagerProfileContainersDrawn === 'function') {
    return effekseer.getManagerProfileContainersDrawn() > 0
  }

  if (typeof effekseer.getDrawCallCount === 'function') {
    return effekseer.getDrawCallCount() > 0
  }

  return null
}

function createTrackerState(effekseer: EffekseerContext): TrackerState {
  const state: TrackerState = {
    trackedHandles: new Set(),
    wrappedHandles: new WeakSet(),
    refCount: 0,
    bootstrapFramesRemaining: 1,
    lastObservedRuntimeActive: false,
    originalPlayEffect: effekseer.playEffect,
    wrappedPlayEffect: ((...args) => {
      return trackHandle(state, state.originalPlayEffect.apply(effekseer, args))
    }) as EffekseerContext['playEffect'],
    originalPlay: effekseer.play,
    wrappedPlay: undefined,
    originalStopAll: effekseer.stopAll,
    wrappedStopAll: (() => {
      try {
        return state.originalStopAll.call(effekseer)
      } finally {
        state.trackedHandles.clear()
        state.lastObservedRuntimeActive = false
        state.bootstrapFramesRemaining = 0
      }
    }) as EffekseerContext['stopAll'],
  }

  if (typeof effekseer.play === 'function') {
    state.wrappedPlay = ((...args) => {
      return trackHandle(state, state.originalPlay?.apply(effekseer, args) ?? null)
    }) as EffekseerContext['play']
  }

  effekseer.playEffect = state.wrappedPlayEffect
  if (state.wrappedPlay) {
    effekseer.play = state.wrappedPlay
  }
  effekseer.stopAll = state.wrappedStopAll

  return state
}

function restoreTrackerState(effekseer: EffekseerContext, state: TrackerState): void {
  if (effekseer.playEffect === state.wrappedPlayEffect) {
    effekseer.playEffect = state.originalPlayEffect
  }

  if (state.wrappedPlay && effekseer.play === state.wrappedPlay) {
    effekseer.play = state.originalPlay
  }

  if (effekseer.stopAll === state.wrappedStopAll) {
    effekseer.stopAll = state.originalStopAll
  }

  state.trackedHandles.clear()
}

export default function createEffekseerActivityTracker(
  effekseer: EffekseerContext
): EffekseerActivityTracker {
  let state = trackerStates.get(effekseer)
  if (!state) {
    state = createTrackerState(effekseer)
    trackerStates.set(effekseer, state)
  }

  state.refCount += 1

  return {
    beforeFrame() {
      sweepInactiveHandles(state)

      return (
        state.trackedHandles.size > 0 ||
        state.bootstrapFramesRemaining > 0 ||
        state.lastObservedRuntimeActive
      )
    },

    afterFrame() {
      if (state.bootstrapFramesRemaining > 0) {
        state.bootstrapFramesRemaining -= 1
      }

      sweepInactiveHandles(state)

      const runtimeActive = resolveRuntimeActivity(effekseer)
      state.lastObservedRuntimeActive =
        runtimeActive === null ? state.trackedHandles.size > 0 : runtimeActive
    },

    dispose() {
      state.refCount -= 1

      if (state.refCount <= 0) {
        restoreTrackerState(effekseer, state)
        trackerStates.delete(effekseer)
      }
    },
  }
}
