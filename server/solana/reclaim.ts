// server/solana/reclaim.ts
//
// MeshPort pays the rent (~0.003 SOL) of every Solana → Arc burn's
// MessageSent event account (it is the burn's event_rent_payer -
// server/solana/feePayer.ts). Circle's MessageTransmitterV2 gives it back:
// reclaim_event_account closes the account and returns the rent to the
// payer who paid it - only that payer can call it, and only 5 days after the
// burn (EVENT_ACCOUNT_WINDOW_SECONDS, so Circle's attestation service has read
// the message first). Circle docs: CCTP Solana programs, depositForBurn
// "MessageSent event storage"; contract: programs/v2/message-transmitter-v2
// instructions/reclaim_event_account.rs.
//
// The instruction needs the message's attestation and the attested
// ("destination") message from Iris; the program checks both against the
// stored message, so a wrong one simply fails and nothing moves. The rent can
// only ever go back to MeshPort's own fee payer.

import { type Address, type Transaction } from '@solana/kit'

export const MESSAGE_TRANSMITTER_V2 = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC'
/** Anchor discriminator: sha256("global:reclaim_event_account")[0..8]. */
export const RECLAIM_EVENT_ACCOUNT = [94, 198, 180, 159, 131, 236, 15, 174]
/** MessageTransmitter::EVENT_ACCOUNT_WINDOW_SECONDS (5 days), plus an hour of margin. */
export const RECLAIM_AFTER_SEC = 5 * 24 * 3600 + 3600
const SOLANA_DOMAIN = 5

/** reclaim_event_account data: discriminator, then Borsh { attestation: Vec<u8>, destination_message: Vec<u8> }. Pure. */
export function reclaimData(attestation: Uint8Array, destinationMessage: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + 4 + attestation.length + 4 + destinationMessage.length)
  const view = new DataView(out.buffer)
  out.set(RECLAIM_EVENT_ACCOUNT, 0)
  view.setUint32(8, attestation.length, true)
  out.set(attestation, 12)
  view.setUint32(12 + attestation.length, destinationMessage.length, true)
  out.set(destinationMessage, 16 + attestation.length)
  return out
}

/** MessageSent account layout: discriminator(8) rent_payer(32) created_at i64(8) message(Vec). Pure. */
export function readEventAccount(data: Uint8Array): { rentPayer: Uint8Array; createdAt: number } | null {
  if (data.length < 48) return null
  const createdAt = Number(new DataView(data.buffer, data.byteOffset).getBigInt64(40, true))
  return { rentPayer: data.slice(8, 40), createdAt }
}

const hexBytes = (h: string) => new Uint8Array((h.replace(/^0x/, '').match(/../g) ?? []).map(b => parseInt(b, 16)))

type Rpc = <T>(method: string, params: unknown[]) => Promise<T>

/** Event accounts whose rent MeshPort's fee payer paid, old enough to reclaim (oldest first). */
export async function reclaimableAccounts(rpc: Rpc, feePayer: string, nowSec: number): Promise<Array<{ account: string; createdAt: number; lamports: number }>> {
  const rows = await rpc<Array<{ pubkey: string; account: { lamports: number; data: [string, string] } }>>('getProgramAccounts', [
    MESSAGE_TRANSMITTER_V2,
    { encoding: 'base64', dataSlice: { offset: 0, length: 48 }, filters: [{ memcmp: { offset: 8, bytes: feePayer } }] },
  ])
  return rows
    .map(r => ({ r, ev: readEventAccount(new Uint8Array(Buffer.from(r.account.data[0], 'base64'))) }))
    .filter(x => x.ev && x.ev.createdAt + RECLAIM_AFTER_SEC <= nowSec)
    .map(x => ({ account: x.r.pubkey, createdAt: x.ev!.createdAt, lamports: x.r.account.lamports }))
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** The burn that created an event account: the oldest transaction that touched it. */
export async function burnSignatureOf(rpc: Rpc, account: string): Promise<string | null> {
  const sigs = await rpc<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [account, { limit: 20 }])
  const ok = sigs.filter(s => !s.err)
  return ok.length ? ok[ok.length - 1].signature : null
}

/** Circle's attested message for a Solana burn (sandbox Iris for devnet). */
export async function attestedMessage(iris: string, signature: string): Promise<{ message: Uint8Array; attestation: Uint8Array } | null> {
  const r = await fetch(`${iris}/v2/messages/${SOLANA_DOMAIN}?transactionHash=${signature}`, { signal: AbortSignal.timeout(8_000) })
  if (!r.ok) return null
  const m = (await r.json() as { messages?: Array<{ status?: string; message?: string; attestation?: string }> }).messages?.[0]
  if (m?.status !== 'complete' || !m.message || !m.attestation || m.attestation === 'PENDING') return null
  return { message: hexBytes(m.message), attestation: hexBytes(m.attestation) }
}

function computeLimit(units: number) {
  const data = new Uint8Array(5)
  data[0] = 2
  new DataView(data.buffer).setUint32(1, units, true)
  return { programAddress: 'ComputeBudget111111111111111111111111111111' as Address, accounts: [], data }
}

/** reclaim_event_account, signed by the fee payer (the only signer). */
export async function reclaimTransaction(p: {
  eventAccount: string; attestation: Uint8Array; message: Uint8Array; keys: CryptoKeyPair; feePayer: string
  lifetime: { blockhash: string; lastValidBlockHeight: bigint }
}): Promise<Transaction> {
  const kit = await import('@solana/kit')
  const R = kit.AccountRole
  const [messageTransmitter] = await kit.getProgramDerivedAddress({
    programAddress: kit.address(MESSAGE_TRANSMITTER_V2), seeds: [new TextEncoder().encode('message_transmitter')],
  })
  const ix = {
    programAddress: kit.address(MESSAGE_TRANSMITTER_V2),
    accounts: [
      { address: kit.address(p.feePayer), role: R.WRITABLE_SIGNER },        // payee (the original rent payer)
      { address: messageTransmitter as Address, role: R.WRITABLE },
      { address: kit.address(p.eventAccount), role: R.WRITABLE },          // message_sent_event_data (closed)
    ],
    data: reclaimData(p.attestation, p.message),
  }
  const message = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    m => kit.setTransactionMessageFeePayer(kit.address(p.feePayer), m),
    m => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: p.lifetime.blockhash as any, lastValidBlockHeight: p.lifetime.lastValidBlockHeight }, m),
    // ~157k compute units on devnet (27 Nov): 300k so it never runs short.
    m => kit.appendTransactionMessageInstructions([computeLimit(300_000), ix], m),
  )
  return kit.signTransaction([p.keys], kit.compileTransaction(message))
}
