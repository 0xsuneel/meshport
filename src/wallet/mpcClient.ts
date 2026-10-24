// src/wallet/mpcClient.ts
//
// The app's part in the MPC wallet (docs/MPC_WALLET.md): it carries sealed
// boxes between the wallet frame (phone + backup parties) and MeshPort's
// signing service, /api/wallet-mpc (party 2). It never holds a key share or
// sees a protocol message - only boxes encrypted end to end between those two.
//
//   signup   frame.keygenBegin → POST keygen-begin → frame.keygenNext → POST keygen-step …
//            → frame.keygenFinish(address)                       3 POSTs
//   sign     frame.signBegin → POST sign-begin → frame.signNext → POST sign-step
//            → frame.signNext → signature                        2 POSTs
//
// Both the frame and the POST are passed in, so tests can wire them to the
// real engine and service directly.

import type { EcdsaSig, Hex } from './mpc/protocol'
import type { MpcSignRequest } from './protocol'

export type { MpcSignRequest }

/** The wallet frame's MPC requests (wallet-frame/src/main.ts). */
export interface MpcFrame {
  keygenBegin(): Promise<{ session: string; phonePub: Hex }>
  keygenNext(session: string, reply: unknown): Promise<{ box: string }>
  /** Checks the address against its own shares and stores them. */
  keygenFinish(session: string, address: Hex): Promise<{ address: Hex }>
  signBegin(address: Hex, request: MpcSignRequest): Promise<{ session: string; phonePub: Hex; with: number; hash: Hex }>
  signNext(session: string, reply: unknown): Promise<{ box: string } | { signature: EcdsaSig }>
}

/** POST a JSON body to /api/wallet-mpc as the signed-in user; resolves to the JSON reply or throws. */
export type MpcPost = (body: Record<string, unknown>) => Promise<any>

/** Create the user's MPC wallet. Resolves to its address. */
export async function mpcSignup(frame: MpcFrame, post: MpcPost): Promise<Hex> {
  const { session, phonePub } = await frame.keygenBegin()
  let reply = await post({ action: 'keygen-begin', phonePub })
  // Signup is 3 requests; a few spare rounds before giving up.
  for (let i = 0; i < 6; i++) {
    const { box } = await frame.keygenNext(session, reply)
    const next = await post({ action: 'keygen-step', token: reply.token, box })
    if (next.address) return (await frame.keygenFinish(session, next.address)).address
    reply = next
  }
  throw new Error('Wallet setup did not finish - try again')
}

/** Sign `request` with the MPC wallet at `address`: the phone's share and MeshPort's together. */
export async function mpcSign(frame: MpcFrame, post: MpcPost, address: Hex, request: MpcSignRequest): Promise<EcdsaSig> {
  const begin = await frame.signBegin(address, request)
  const reply = await post({ action: 'sign-begin', with: begin.with, request, phonePub: begin.phonePub })
  // The frame refuses on its own if the service would sign anything else;
  // checking here too gives a clearer error.
  if (String(reply.hash).toLowerCase() !== begin.hash.toLowerCase()) throw new Error('The signing service would sign something else')
  const step1 = await frame.signNext(begin.session, reply)
  if (!('box' in step1)) throw new Error('Unexpected signing step')
  const done = await frame.signNext(begin.session, await post({ action: 'sign-step', token: reply.token, box: step1.box }))
  if (!('signature' in done)) throw new Error('Signing did not finish - try again')
  return done.signature
}
