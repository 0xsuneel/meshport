import { describe, it, expect } from 'vitest'
import { projectMomentum } from './gesture'

describe('swipe momentum projection', () => {
  it('a quick flick projects far enough to switch a 350px card', () => {
    // 500 px/s → ~250px of coast; with 20px of drag that's past half a card.
    expect(20 + projectMomentum(-500)).toBeLessThan(-175)
  })
  it('a slow release barely coasts', () => {
    expect(Math.abs(projectMomentum(50))).toBeLessThan(30)
  })
  it('keeps the direction of the release', () => {
    expect(projectMomentum(-300)).toBeLessThan(0)
    expect(projectMomentum(0)).toBe(0)
  })
})
