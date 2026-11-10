import { describe, it, expect } from 'vitest'
import { qrRevealPose } from './qrReveal'

describe('qrRevealPose', () => {
  it('starts small, hidden and unprinted', () => {
    expect(qrRevealPose(0)).toMatchObject({ scale: 0.4, opacity: 0, printed: 0, lineOpacity: 0 })
  })
  it('ends full size, printed, line gone', () => {
    const r = qrRevealPose(1)
    expect(r.scale).toBe(1); expect(r.opacity).toBe(1); expect(r.printed).toBe(1); expect(r.lineOpacity).toBe(0)
  })
  it('clamps outside 0..1', () => {
    expect(qrRevealPose(-3)).toEqual(qrRevealPose(0))
    expect(qrRevealPose(9)).toEqual(qrRevealPose(1))
  })
  // The CSS keyframe stops in index.css are these points of the curve.
  it('matches the CSS keyframe stops', () => {
    expect(qrRevealPose(0.13649).printed).toBeCloseTo(0, 3)
    expect(qrRevealPose(0.94351).printed).toBeCloseTo(1, 3)
    expect(qrRevealPose(0.91123).lineOpacity).toBeCloseTo(1, 2)
    expect(qrRevealPose(0.99193).lineOpacity).toBeCloseTo(0, 2)
    expect(qrRevealPose(1 / 6).opacity).toBeCloseTo(1, 3)
    expect(qrRevealPose(0.08).line).toBeCloseTo(-0.07, 5)
  })
})
