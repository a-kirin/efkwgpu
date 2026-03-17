# WebGPU Add-on Examples

This Vite app hosts the consumers for the `three-effekseer` add-on.

## Entries

- `/vanilla/`: canonical add-on reference. Uses plain HTML plus [vanilla-main.ts](./src/vanilla-main.ts).
- `/`: React consumer parity example. Uses [ThreeEffekseerCanvas.tsx](./src/ThreeEffekseerCanvas.tsx).

The add-on source lives in [../addons/three-effekseer](../addons/three-effekseer), and its public contract is documented in [../addons/three-effekseer/README.md](../addons/three-effekseer/README.md).

## Commands

```bash
npm install
npm run dev
npm run build
```

## Runtime

Both entries expect the Effekseer WebGPU runtime to be available under `/effekseer-runtime/`.
