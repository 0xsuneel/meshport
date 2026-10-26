import { describe, it, expect, vi } from 'vitest'
import { pressable } from './pressable'

const key = (k: string, sameTarget = true) => {
  const el = {}
  return { key: k, target: el, currentTarget: sameTarget ? el : {}, preventDefault: vi.fn() } as any
}

describe('pressable rows', () => {
  it('is a focusable button to assistive tech', () => {
    const p = pressable(() => {}, 'Open USDC')
    expect(p.role).toBe('button')
    expect(p.tabIndex).toBe(0)
    expect(p['aria-label']).toBe('Open USDC')
  })
  it('Enter and Space press it; other keys do not', () => {
    const fn = vi.fn()
    const p = pressable(fn)
    p.onKeyDown(key('Enter')); p.onKeyDown(key(' ')); p.onKeyDown(key('a'))
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('leaves keys from a control inside the row alone', () => {
    const fn = vi.fn()
    pressable(fn).onKeyDown(key('Enter', false))
    expect(fn).not.toHaveBeenCalled()
  })
})
