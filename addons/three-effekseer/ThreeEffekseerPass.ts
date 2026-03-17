import createBasicPass from './createBasicPass'
import createCompositePass from './createCompositePass'
import type { ThreeEffekseerPass, ThreeEffekseerPassInit, ThreeEffekseerPassOptions } from './types'

export default function createThreeEffekseerPass(
  init: ThreeEffekseerPassInit,
  options: ThreeEffekseerPassOptions = {}
): ThreeEffekseerPass {
  if (options.mode === 'composite') {
    return createCompositePass(init)
  }

  return createBasicPass(init)
}
