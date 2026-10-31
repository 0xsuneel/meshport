import { describe, it, expect } from 'vitest'
import {
  moveSteps, indexFromStepStates, indexFromCctpStage, indexFromClaimStatus, indexFromUbIntent,
  indexFromBringStage, safeFromIndex, MOVE_STEP_COUNT,
} from './moveSteps'

describe('moveSteps', () => {
  it('has four real steps for every kind and route', () => {
    for (const kind of ['transfer', 'bring'] as const) for (const route of ['cctp', 'ub'] as const) {
      const s = moveSteps({ kind, route, from: kind === 'transfer' ? 'Arc' : 'Base', to: kind === 'transfer' ? 'Base' : 'Arc', amount: '10.00' })
      expect(s).toHaveLength(MOVE_STEP_COUNT)
      for (const step of s) expect(step.label && step.upcoming && step.active && step.done && step.eta).toBeTruthy()
    }
  })
  it('follows Circle CCTP naming for a transfer', () => {
    const s = moveSteps({ kind: 'transfer', route: 'cctp', from: 'Arc', to: 'Base', amount: '1.00' })
    expect(s.map(x => x.label)).toEqual(['Approve USDC', 'Burn on Arc', 'Circle attestation', 'Mint on Base'])
  })
  it('names the minter for relayer chains', () => {
    const s = moveSteps({ kind: 'transfer', route: 'cctp', from: 'Arc', to: 'Plume', amount: '1.00', forwarder: false })
    expect(s[3].active).toContain('MeshPort')
  })
  it('gives a bring over UB its own finality wait', () => {
    expect(moveSteps({ kind: 'bring', route: 'ub', from: 'Ethereum', to: 'Arc', amount: '1.00' })[2].eta).toBe('up to 15 minutes')
    expect(moveSteps({ kind: 'bring', route: 'ub', from: 'Base', to: 'Arc', amount: '1.00', fastFinality: true })[2].eta).toBe('under a minute')
  })
})

describe('step index mappers', () => {
  it('reads SDK step states', () => {
    expect(indexFromStepStates(['done', 'active', 'pending', 'pending'])).toBe(1)
    expect(indexFromStepStates(['done', 'done', 'done', 'done'])).toBe(4)
    expect(indexFromStepStates(['done', 'error', 'pending', 'pending'])).toBe(1)
  })
  it('reads Circle attestation stages', () => {
    expect(indexFromCctpStage('burning')).toBe(1)
    expect(indexFromCctpStage('attesting')).toBe(2)
    expect(indexFromCctpStage('minting')).toBe(3)
    expect(indexFromCctpStage('done')).toBe(4)
  })
  it('reads claims rows and UB intents', () => {
    expect(indexFromClaimStatus('submitted')).toBe(1)
    expect(indexFromClaimStatus('bridging')).toBe(2)
    expect(indexFromClaimStatus('settling')).toBe(3)
    expect(indexFromClaimStatus('completed')).toBe(4)
    expect(indexFromUbIntent('pending')).toBe(2)
    expect(indexFromUbIntent('submitted')).toBe(3)
    expect(indexFromUbIntent('completed')).toBe(4)
  })
  it('only moves a UB bring past signing once it is handed off', () => {
    expect(indexFromBringStage('ub', 'approving')).toBe(0)
    expect(indexFromBringStage('ub', 'attesting')).toBe(1)
    expect(indexFromBringStage('ub', 'attesting', true)).toBe(2)
    expect(indexFromBringStage('cctp', 'burning')).toBe(1)
    expect(indexFromBringStage('cctp', 'attesting')).toBe(2)
  })
  it('only calls it safe to leave once the server or Circle finishes it', () => {
    expect(safeFromIndex('transfer', 'cctp', { forwarder: true })).toBe(2)
    expect(safeFromIndex('transfer', 'cctp', { forwarder: false })).toBe(4)
    expect(safeFromIndex('transfer', 'ub')).toBe(4)
    expect(safeFromIndex('bring', 'cctp')).toBe(2)
    expect(safeFromIndex('bring', 'ub')).toBe(2)
  })
})

describe('step texts', () => {
  it('never repeat the step name or the Safe to leave note', () => {
    for (const kind of ['transfer', 'bring'] as const) for (const route of ['cctp', 'ub'] as const) {
      const steps = moveSteps({ kind, route, from: kind === 'transfer' ? 'Arc' : 'Ethereum', to: kind === 'transfer' ? 'Base' : 'Arc', amount: '10.00' })
      for (const s of steps) {
        const name = s.label.toLowerCase()
        for (const t of [s.upcoming, s.done]) expect(t.toLowerCase()).not.toBe(name)
        expect(s.done.toLowerCase()).not.toContain(name)
        for (const t of [s.upcoming, s.active, s.done]) expect(t).not.toMatch(/close the app/i)
      }
      // No two steps say the same thing.
      expect(new Set(steps.map(s => s.done)).size).toBe(steps.length)
      expect(new Set(steps.map(s => s.upcoming)).size).toBe(steps.length)
    }
  })
})

describe('moveSteps: EURC / cirBTC (Circle CCTPx)', () => {
  it('Transfer says send and deliver, in the coin - never USDC, burn or mint', () => {
    const steps = moveSteps({ kind: 'transfer', route: 'cctp', from: 'Arc', to: 'Base', amount: '25', recipient: '0xabc…1234', token: 'EURC' })
    expect(steps.map(s => s.label)).toEqual(['Approve EURC', 'Send from Arc', 'Circle attestation', 'Deliver on Base'])
    const text = JSON.stringify(steps)
    expect(text).toContain('25 EURC')
    expect(text).not.toMatch(/USDC|[Bb]urn|[Mm]int/)
  })
  it('Bring says MeshPort pays the gas and Circle fee, and the coin lands on Arc', () => {
    const steps = moveSteps({ kind: 'bring', route: 'cctp', from: 'Ethereum', to: 'Arc', amount: '0.0005', token: 'cirBTC' })
    expect(steps.map(s => s.label)).toEqual(['Sign on Ethereum', 'Send from Ethereum', 'Circle attestation', 'Deliver on Arc'])
    expect(steps[3].done).toBe('cirBTC is in your Arc wallet')
    expect(JSON.stringify(steps)).not.toMatch(/USDC|[Bb]urn|[Mm]int/)
  })
  it('USDC is unchanged', () => {
    expect(moveSteps({ kind: 'bring', route: 'cctp', from: 'Base', to: 'Arc', amount: '5', token: 'USDC' })[3].label).toBe('Mint on Arc')
  })
})
