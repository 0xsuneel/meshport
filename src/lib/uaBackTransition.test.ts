import { describe, it, expect } from 'vitest'
import { browserAnimatedBack, _notePopForTests } from './uaBackTransition'

describe('browserAnimatedBack', () => {
  it('is true right after a back the browser animated', () => {
    _notePopForTests(true, 10_000)
    expect(browserAnimatedBack(10_200)).toBe(true)
  })
  it('is false for a plain back, or a stale one', () => {
    _notePopForTests(false, 10_000)
    expect(browserAnimatedBack(10_100)).toBe(false)
    _notePopForTests(true, 10_000)
    expect(browserAnimatedBack(12_000)).toBe(false)
  })
})
