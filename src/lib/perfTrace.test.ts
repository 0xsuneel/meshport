import { describe, it, expect, vi, beforeEach } from 'vitest'

const reports: string[] = []
vi.mock('./errorReport', () => ({ reportPerf: (l: string) => reports.push(l) }))

import { markStartup, startupTimings, reportPayment, resetPerfTrace, sendStartupReport } from './perfTrace'

const flush = () => new Promise(r => setTimeout(r, 5))

describe('perf trace', () => {
  beforeEach(() => { resetPerfTrace(); reports.length = 0 })

  it('each startup mark counts once; signer + first RPC make the app ready for a first action', async () => {
    markStartup('signer')
    const first = startupTimings().signer
    markStartup('signer')
    expect(startupTimings().signer).toBe(first)
    expect(startupTimings().actionReady).toBeUndefined()
    markStartup('rpc')
    expect(startupTimings().actionReady).toBeDefined()
    await flush()
    expect(reports.length).toBe(1)
    expect(reports[0]).toMatch(/^\[perf startup\] (cold|reload), since page load \(s\): .*signer .*rpc .*actionReady/)
  })

  it('one startup line per page load', async () => {
    markStartup('shell'); sendStartupReport(); sendStartupReport()
    await flush()
    expect(reports.length).toBe(1)
  })

  it('a payment line carries stage durations and the outcome only', async () => {
    reportPayment({ prepare: 120, sign: 900, broadcast: 650 }, 'success')
    await flush()
    expect(reports[0]).toBe('[perf pay] prepare 0.12, sign 0.90, broadcast 0.65, confirm - (success)')
  })
})
