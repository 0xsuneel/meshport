// src/wallet/mpc/phone.ts
//
// The phone's side of the MPC wallet, as the wallet frame runs it. The app
// drives the HTTP calls to api/wallet-mpc and hands each reply in; these
// classes open the server's box, run every local round they can, and give
// back the next box to send. The app only ever sees sealed boxes.
//
//   signup   new PhoneKeygen → begin(reply 0) → box → next(reply 1) → box → finish(address)
//            (the phone plays party 1 and the backup, party 3)
//   pay      new PhoneSign  → begin(reply 0) → box → next(reply 1) → signature

import { ChannelError, newEphemeral, openChannel, verifyHello, type Channel } from './channel'
import {
  BACKUP, PHONE, SERVER, keygenReady, keygenStart, keygenStep, signReady, signStart, signStep,
  type EcdsaSig, type Hex, type KeyShare, type KeygenState, type MpcMsg, type PartyNo, type SignState,
} from './protocol'
import type { Mpc } from './wasm'

export interface ServerHello { serverPub: Hex; sig: Hex }

const LOCAL = [PHONE, BACKUP] as const

/**
 * Runs one key-generation step somewhere else - in the frame, a second Web
 * Worker - so the backup party's work uses another CPU core while the phone
 * party's runs here. Same inputs and output as keygenStep.
 */
export type KeygenOffload = (state: KeygenState, inbox: MpcMsg[]) => Promise<ReturnType<typeof keygenStep>>

/** Signup. One instance per attempt; throw it away on any error. */
export class PhoneKeygen {
  private eph = newEphemeral()
  private channel: Channel | null = null
  private sid: Hex | null = null
  private states = new Map<PartyNo, KeygenState>()
  private mail: MpcMsg[] = []
  private done = new Map<PartyNo, { share: KeyShare; address: Hex }>()
  private step = 0

  /** `offload`: where the backup party's steps run (default: here, after the phone's). */
  constructor(private mpc: Mpc, private identityPub: Hex, private offload?: KeygenOffload) {}

  /** Send with keygen-begin. */
  get phonePub(): Hex { return this.eph.pub }

  /** keygen-begin's reply → the box for the first keygen-step. */
  async begin(reply: { sid: Hex; hello: ServerHello; box: string }): Promise<string> {
    if (this.channel) throw new ChannelError('already started')
    await verifyHello(this.identityPub, 'keygen', reply.sid, this.eph.pub, reply.hello.serverPub, reply.hello.sig)
    this.sid = reply.sid
    this.channel = await openChannel('phone', this.eph.priv, reply.hello.serverPub, 'keygen', reply.sid)
    this.mail.push(...await this.channel.open(reply.box, 0))
    const out: MpcMsg[] = []
    for (const p of LOCAL) {
      const r = keygenStart(this.mpc, p, reply.sid)
      this.states.set(p, r.state)
      out.push(...r.out)
    }
    return this.run(out)
  }

  /** A keygen-step reply with a box → the box for the next keygen-step. */
  async next(reply: { box: string }): Promise<string> {
    if (!this.channel) throw new ChannelError('not started')
    this.mail.push(...await this.channel.open(reply.box, this.step))
    return this.run([])
  }

  /**
   * The final reply carries only the server's address: both local shares
   * must agree with it. Returns the phone's share and the backup share.
   */
  finish(reply: { address: Hex }): { phone: KeyShare; backup: KeyShare; address: Hex } {
    const phone = this.done.get(PHONE), backup = this.done.get(BACKUP)
    if (!phone || !backup) throw new ChannelError('key generation is not finished')
    const address = reply.address.toLowerCase() as Hex
    if (phone.address !== address || backup.address !== address) throw new ChannelError('The server finished with a different wallet')
    return { phone: phone.share, backup: backup.share, address }
  }

  get finished(): boolean { return this.done.size === LOCAL.length }

  /**
   * Both local shares, as soon as they exist - one request before the server
   * finishes. Store them now: if that fails, signup stops before the server
   * saves its share, so it is never left with a wallet nobody can use.
   * The address is this phone's own result; finish() checks the server's.
   */
  get shares(): { phone: KeyShare; backup: KeyShare; address: Hex } | null {
    const phone = this.done.get(PHONE), backup = this.done.get(BACKUP)
    if (!phone || !backup) return null
    if (phone.address !== backup.address) throw new ChannelError('The two local shares disagree')
    return { phone: phone.share, backup: backup.share, address: phone.address.toLowerCase() as Hex }
  }

  /** Run local parties as far as they can go; seal what the server needs. */
  private async run(sent: MpcMsg[]): Promise<string> {
    this.mail.push(...sent.filter(m => m.to !== SERVER))
    const toServer = sent.filter(m => m.to === SERVER)
    for (;;) {
      // Both local parties' next steps need only earlier rounds' messages, so
      // they can run at the same time: the backup's goes to `offload` first,
      // then the phone's runs here while it works.
      const ready = LOCAL.filter(p => { const st = this.states.get(p); return !!st && keygenReady(st, this.mail) })
      if (!ready.length) break
      const inbox = [...this.mail]
      const runs = [...ready].sort((a, b) => (a === BACKUP ? -1 : b === BACKUP ? 1 : 0)).map(p => {
        const st = this.states.get(p)!
        const r = p === BACKUP && this.offload ? this.offload(st, inbox) : Promise.resolve(keygenStep(this.mpc, st, inbox))
        return r.then(res => [p, res] as const)
      })
      for (const [p, r] of await Promise.all(runs)) {
        this.mail.push(...r.out.filter(m => m.to !== SERVER))
        toServer.push(...r.out.filter(m => m.to === SERVER))
        if (r.done) { this.done.set(p, r.done); this.states.delete(p) } else this.states.set(p, r.state)
      }
    }
    this.step += 1
    return this.channel!.seal(toServer, this.step)
  }
}

/** One signature: the phone's share (or, on a new phone, the backup share) with the server. */
export class PhoneSign {
  private eph = newEphemeral()
  private channel: Channel | null = null
  private state: SignState | null = null
  private mail: MpcMsg[] = []
  private sig: EcdsaSig | null = null
  private step = 0

  /** `hash`: what this frame computed itself from the transaction it was asked to sign. */
  constructor(private mpc: Mpc, private identityPub: Hex, private share: KeyShare, private hash: Hex) {}

  get phonePub(): Hex { return this.eph.pub }
  get with(): PartyNo { return this.share.party_index as PartyNo }

  /** sign-begin's reply → the box for sign-step. */
  async begin(reply: { signId: Hex; hash: Hex; hello: ServerHello; box: string }): Promise<string> {
    if (this.channel) throw new ChannelError('already started')
    // The server signs the hash it computed; refuse if that's not this transaction.
    if (reply.hash.toLowerCase() !== this.hash.toLowerCase()) throw new ChannelError('The server would sign something else')
    await verifyHello(this.identityPub, 'sign', reply.signId, this.eph.pub, reply.hello.serverPub, reply.hello.sig)
    this.channel = await openChannel('phone', this.eph.priv, reply.hello.serverPub, 'sign', reply.signId)
    this.mail.push(...await this.channel.open(reply.box, 0))
    const r = signStart(this.mpc, this.share, SERVER, reply.signId, this.hash)
    this.state = r.state
    return this.run(r.out)
  }

  /** sign-step's reply → the finished signature. */
  async next(reply: { box: string }): Promise<EcdsaSig> {
    if (!this.channel) throw new ChannelError('not started')
    this.mail.push(...await this.channel.open(reply.box, this.step))
    await this.run([])
    if (!this.sig) throw new ChannelError('signing did not finish')
    return this.sig
  }

  private async run(sent: MpcMsg[]): Promise<string> {
    const toServer = [...sent]
    while (this.state && signReady(this.state, this.mail)) {
      const r = signStep(this.mpc, this.share, this.state, this.mail)
      toServer.push(...r.out)
      if (r.done) { this.sig = r.done; this.state = null } else this.state = r.state
    }
    this.step += 1
    return this.channel!.seal(toServer, this.step)
  }
}
