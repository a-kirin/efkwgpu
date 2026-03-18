# three-effekseer

`three-effekseer` is a WebGPU add-on that integrates Effekseer into a patched Three.js WebGPU renderer.

## Version Baseline

This add-on is currently based on Effekseer `1.80 b2`.
The required local Three.js fork baseline is `0.182.0-eff1.0`.

## Requirements

- The local Three.js fork must expose the external render pass hook implemented in:
  - [WebGPURenderer.js](../../node_modules/three/src/renderers/webgpu/WebGPURenderer.js)
  - [WebGPUBackend.js](../../node_modules/three/src/renderers/webgpu/WebGPUBackend.js)
- The Effekseer WebGPU runtime must already be loaded in the page.

## Canonical Example

The canonical consumer of the add-on is the vanilla example:

- HTML entry: [vanilla/index.html](../../react-vite-ts/vanilla/index.html)
- Integration: [vanilla-main.ts](../../react-vite-ts/src/vanilla-main.ts)

The React example in [ThreeEffekseerCanvas.tsx](../../react-vite-ts/src/ThreeEffekseerCanvas.tsx) consumes the same add-on, but it is not the reference integration.

## Public API

```ts
import { EffekseerRenderPass } from 'three-effekseer'

const pass = new EffekseerRenderPass(
  renderer,
  scene,
  camera,
  ctx,
  {
    mode: 'composite',
    idleOptimization: true,
  }
)

const capabilities = pass.getCapabilities()
```

This mirrors the WebGL-side integration format by exposing a dedicated `EffekseerRenderPass` on the Three side while keeping the Effekseer context external.

`mode` defaults to `'basic'`.
`idleOptimization` defaults to `true`.

When `idleOptimization` is enabled, the add-on skips Effekseer work when no
active effects are detected and falls back to rendering the Three scene only.

## Modes

| Mode | Distortion | Depth Occlusion | Soft Particles | LOD | Collisions | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `basic` | No | Yes | No | No | No | Effekseer is injected into the primary scene render pass. Lowest cost path. |
| `composite` | Yes | Yes | Yes | No | No | Uses scene capture for background refraction, converts scene depth into an intermediate float texture for soft particles, renders the scene again into a composite target, then presents through `PostProcessing`. |

## Idle Optimization

With `idleOptimization: true`:

- `basic` keeps `renderer.render(scene, camera)` active, but skips
  `effekseer.update(...)`, the external render pass hook, and `drawExternal(...)`
  while idle.
- `composite` falls back to `renderer.render(scene, camera)` while idle and
  skips `effekseer.update(...)`, `sceneCaptureTrigger.render()`,
  `compositePresenter.render(...)`, and the final presenter pass.

The tracker watches handles returned by `ctx.playEffect(...)` and `ctx.play(...)`
when available, and falls back to runtime metrics such as
`getTotalParticleCount()` when the runtime exposes them.

## Unsupported Features

- `Soft particles` in `basic`: not supported. The external render pass hook in the current Three fork does not expose a sampleable scene depth texture for the primary scene pass.
- `LOD`: not supported. The add-on does not currently provide a Three-side feature contract for effect level-of-detail selection.
- `Collisions`: not supported. The add-on does not currently bridge Three scene collision data or collision callbacks into Effekseer.

## Soft Particles

`composite` mode does not forward Three's raw `DepthTexture` directly to Effekseer. Instead, it renders the scene pass depth into an intermediate sampleable float color texture and then forwards that texture to Effekseer through `depthTextureView`.

If the scene pass does not expose a depth texture, or if the intermediate float depth capture cannot be produced for the current backend/format, the add-on silently falls back to rendering Effekseer without soft particles for that frame.
