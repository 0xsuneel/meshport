// Waiting (e2e:q2) messages handed over to the recipient, end to end through
// resealWaitingMessages - including the conversation's stored preview, which
// otherwise kept the q2 ciphertext (recipient's chat list: "Waiting…" forever).
// Also: an encrypted photo/file is never passed through as ciphertext when
// the key isn't there yet.
import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'

const ALICE_PK = '0x' + '11'.repeat(32)
const BOB_PK = '0x' + '22'.repeat(32)

type Op = { table: string; op: string; args: unknown[] }
const ops: Op[] = []
const state: { waiting: any[]; bobRow: any } = { waiting: [], bobRow: null }

function builder(table: string) {
  const calls: Op[] = []
  const b: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        const isUpdate = calls.some(c => c.op === 'update')
        const result = isUpdate ? { error: null }
          : table === 'messages' ? { data: state.waiting }
          : table === 'conversations' ? { data: [{ id: 'c1', participant_a: 'alice', participant_b: 'bob' }] }
          : { data: null }
        if (isUpdate) ops.push(...calls)
        return (res: any) => res(result)
      }
      if (prop === 'maybeSingle') return async () => ({ data: table === 'users' ? state.bobRow : null, error: null })
      return (...args: unknown[]) => { calls.push({ table, op: prop, args }); return b }
    },
  })
  return b
}

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => builder(t) } }))
vi.mock('@/lib/homeBootstrap', () => ({ bootPart: async () => undefined }))
vi.mock('@/lib/security', () => ({ sealForDevice: async () => null, openFromDevice: async () => null }))
vi.mock('@/store', () => ({ useAuthStore: { getState: () => ({ privateKey: ALICE_PK }) } }))

import {
  deriveMyChatIdentity, makeChatKeys, encryptText, decryptText, encryptBlob, decryptBlob,
  chatKeyStatement, resealWaitingMessages, isWaitingPayload,
} from './chatCrypto'

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u))

describe('resealWaitingMessages', () => {
  it('hands the message over and updates the conversation preview that still holds the q2 copy', async () => {
    const alice = deriveMyChatIdentity(ALICE_PK)
    const bob = deriveMyChatIdentity(BOB_PK)
    const aliceAddr = privateKeyToAccount(ALICE_PK as `0x${string}`).address
    const bobAddr = privateKeyToAccount(BOB_PK as `0x${string}`).address
    const bobPub = b64(bob.publicKey)
    const sig = await privateKeyToAccount(BOB_PK as `0x${string}`).signMessage({ message: chatKeyStatement(bobAddr, bobPub) })
    state.bobRow = { chat_public_key: bobPub, chat_key_sig: sig, wallet_address: bobAddr }

    const q2 = await encryptText('hi bob', await makeChatKeys(alice.privateKey, null))
    expect(isWaitingPayload(q2)).toBe(true)
    state.waiting = [{ id: 'm1', conversation_id: 'c1', content: q2 }]

    expect(await resealWaitingMessages(aliceAddr, 'alice')).toBe(1)

    const msgUpdate = ops.find(o => o.table === 'messages' && o.op === 'update')!
    const sealed = (msgUpdate.args[0] as any).content as string
    expect(sealed.startsWith('e2e:v2:')).toBe(true)
    expect(await decryptText(sealed, await makeChatKeys(bob.privateKey, alice.publicKey))).toBe('hi bob')

    const convOps = ops.filter(o => o.table === 'conversations')
    expect(convOps.find(o => o.op === 'update')?.args[0]).toEqual({ last_message: sealed })
    // Only when the preview IS that waiting message - a newer one is left alone.
    expect(convOps.filter(o => o.op === 'eq').map(o => o.args)).toEqual([['id', 'c1'], ['last_message', q2]])
  })
})

describe('decryptBlob without a key', () => {
  it('rejects instead of passing the ciphertext through as the file', async () => {
    const alice = deriveMyChatIdentity(ALICE_PK)
    const bob = deriveMyChatIdentity(BOB_PK)
    const keys = await makeChatKeys(alice.privateKey, bob.publicKey)
    const { blob, ivBase64 } = await encryptBlob(new Blob([new Uint8Array([1, 2, 3])]), keys)
    const ct = await blob.arrayBuffer()
    await expect(decryptBlob(ct, ivBase64, null)).rejects.toBeTruthy()
    await expect(decryptBlob(ct, ivBase64, undefined)).rejects.toBeTruthy()
    // Never-encrypted files still pass through.
    const plain = await decryptBlob(new Uint8Array([9]).buffer, null, null)
    expect(Array.from(new Uint8Array(await plain.arrayBuffer()))).toEqual([9])
  })
})
