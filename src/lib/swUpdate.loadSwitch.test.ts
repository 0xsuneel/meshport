import { describe, it, expect } from 'vitest'
import { decideLoadSwitch } from './swUpdate'

// On opening the app, a new version is switched to only in the opening
// moment - never after the person has started using the app (a switch ~20 s
// after opening made a payment run during the new version's start-up).
describe('switching to a new version when the app opens', () => {
  it('found within the first 3 s, before any tap: switch behind the opening screen', () => {
    expect(decideLoadSwitch(true, 1800, 3000, false)).toBe(true)
  })
  it('found later (slow connection): wait - pill, background on a resting screen, or next open', () => {
    expect(decideLoadSwitch(true, 20_000, 3000, false)).toBe(false)
  })
  it('the person already tapped / typed: wait, however soon it was found', () => {
    expect(decideLoadSwitch(true, 1500, 3000, true)).toBe(false)
  })
  it('no newer version: nothing to do', () => {
    expect(decideLoadSwitch(false, 500, 3000, false)).toBe(false)
  })
})
