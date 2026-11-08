// A reload between create and set-passcode must not lose the recovery phrase.
// IndexedDB (fake) is present here, so the device seal works and session
// copies are written - unlike vault.test.ts, which runs without one.
import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'

class MemStorage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
  values() { return [...this.m.values()] }
}
const local = new MemStorage()
const session = new MemStorage()
vi.stubGlobal('localStorage', local)
vi.stubGlobal('sessionStorage', session)

const phrase = 'test test test test test test test test test test test junk'
const k = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const a = privateKeyToAccount(k).address

describe('wallet frame vault - reload before a passcode is set', () => {
  it('reopens the key and the phrase from the session copies, then drops the phrase copy once saved', async () => {
    let vault = await import('./vault')
    await vault.store(a, k, { kind: 'create', mnemonic: phrase })
    // Sealed, never readable.
    expect(session.values().some(v => v.includes('test test'))).toBe(false)

    vi.resetModules() // a reload: the frame's memory is gone, storage stays
    vault = await import('./vault')
    expect(vault.phraseInMemory(a)).toBeNull()
    expect(await vault.unlock(a)).toBe(true)
    expect(vault.phraseInMemory(a)).toBe(phrase)

    await vault.setPasscode(a, '654321')
    expect(await vault.readPhrase(a, '654321')).toBe(phrase)
    vi.resetModules()
    vault = await import('./vault')
    expect(await vault.unlock(a)).toBe(true)
    expect(vault.phraseInMemory(a)).toBeNull() // only behind the passcode now
  })

  it('lock drops the session phrase copy', async () => {
    let vault = await import('./vault')
    await vault.store(a, k, { kind: 'create', mnemonic: phrase })
    vault.lock(a)
    vi.resetModules()
    vault = await import('./vault')
    expect(await vault.unlock(a)).toBe(false)
    expect(vault.phraseInMemory(a)).toBeNull()
  })
})
