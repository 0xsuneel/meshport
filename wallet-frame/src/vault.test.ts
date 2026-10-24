import { describe, it, expect, beforeEach, vi } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// Frame-origin storage stand-ins (node has none). IndexedDB stays absent, so
// sealForDevice returns null - the vault must then keep keys in memory only
// and never write a key unsealed.
class MemStorage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
  dump() { return [...this.m.entries()] }
}
const local = new MemStorage()
const session = new MemStorage()
vi.stubGlobal('localStorage', local)
vi.stubGlobal('sessionStorage', session)

const vault = await import('./vault')

const pk = generatePrivateKey()
const address = privateKeyToAccount(pk).address

describe('wallet frame vault', () => {
  beforeEach(() => { vault.forget(undefined, true); local.clear(); session.clear() })

  it('stores a create/import wallet under the passcode and reopens it only with that passcode', async () => {
    await vault.store(address, pk, { kind: 'import-privkey', passcode: '123456' })
    expect(vault.keyFor(address)).toBe(pk)
    vault.lock(address)
    expect(() => vault.keyFor(address)).toThrow(/locked/)
    expect(await vault.unlock(address)).toBe(false)             // no prompt-free copy without a device key
    await expect(vault.unlock(address, '000000')).rejects.toMatchObject({ code: 'bad-passcode' })
    expect(await vault.unlock(address, '123456')).toBe(true)
    expect(vault.keyFor(address)).toBe(pk)
  })

  it('never writes the key or the phrase in readable form', async () => {
    const phrase = 'test test test test test test test test test test test junk'
    await vault.store(address, pk, { kind: 'create', passcode: '123456', mnemonic: phrase })
    const everything = JSON.stringify([...local.dump(), ...session.dump()]).toLowerCase()
    expect(everything).not.toContain(pk.slice(2).toLowerCase())
    expect(everything).not.toContain('test test')
  })

  it('slows down passcode guessing: 5 free tries, then a wait that the frame enforces', async () => {
    await vault.store(address, pk, { kind: 'import-privkey', passcode: '123456' })
    vault.lock(address)
    for (let i = 0; i < 4; i++) await expect(vault.unlock(address, '000000')).rejects.toMatchObject({ code: 'bad-passcode' })
    await expect(vault.unlock(address, '000000')).rejects.toMatchObject({ code: 'rate-limited' })
    // Even the right passcode waits now.
    await expect(vault.unlock(address, '123456')).rejects.toMatchObject({ code: 'rate-limited' })
    expect((await vault.status(address)).lockedForMs).toBeGreaterThan(0)
  })

  it('refuses a key that does not belong to the address', async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address
    await expect(vault.store(other, pk, { kind: 'import-privkey' })).rejects.toMatchObject({ code: 'mismatch' })
    await expect(vault.openRecovered(other, pk)).rejects.toMatchObject({ code: 'mismatch' })
  })

  it('keeps a new phrase open until a passcode saves it, then only behind the passcode', async () => {
    const phrase = 'test test test test test test test test test test test junk'
    const k = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // that phrase's m/44'/60'/0'/0/0
    const a = privateKeyToAccount(k).address
    await vault.store(a, k, { kind: 'create', mnemonic: phrase })
    expect(vault.phraseInMemory(a)).toBe(phrase)
    await vault.setPasscode(a, '654321')
    expect(vault.phraseInMemory(a)).toBeNull()
    expect(await vault.readPhrase(a, '654321')).toBe(phrase)
    await expect(vault.readPhrase(a, '111111')).rejects.toMatchObject({ code: 'bad-passcode' })
    expect((await vault.status(a)).wordCount).toBe(12)
  })

  it('logout forgets open keys and device copies but keeps passcode copies', async () => {
    await vault.store(address, pk, { kind: 'import-privkey', passcode: '123456' })
    vault.forget(address)
    expect(() => vault.keyFor(address)).toThrow()
    expect((await vault.status(address)).passcode).toBe(true)
    vault.forget(address, true)
    expect((await vault.status(address)).passcode).toBe(false)
  })
})
