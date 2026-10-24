// wallet-frame/src/passkey.ts
//
// The visible page where a passkey ceremony happens (passkey.html#t=<ticket>).
// Browsers only allow WebAuthn in a cross-origin iframe after a tap inside
// it, so the person taps the button here. The request itself (create, or
// sign which hash with which passkey) comes from the hidden wallet frame over
// a same-origin BroadcastChannel - never from this page's URL - and the
// result goes back the same way. Only public data leaves: a public key, or a
// signature already in Safe's format.

import { PASSKEY_CHANNEL, type PasskeyOutcome, type PasskeyRequest } from '@/wallet/protocol'
import { base64url, encodePasskeySignature, p256FromSpki } from '@/wallet/safe/passkeySignature'
import { hexToBytes, toHex } from 'viem'

const RP_NAME = 'MeshPort'
// The passkey's relying party. Production: the app's site (e.g. meshport.xyz),
// which this subdomain may claim; dev: this page's own host.
const RP_ID = (import.meta.env.VITE_WALLET_RP_ID as string | undefined) || location.hostname

const params = new URLSearchParams(location.hash.slice(1))
const ticket = params.get('t') ?? ''
history.replaceState(null, '', location.pathname)
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark'
const root = document.getElementById('root')!

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}
const show = (...nodes: Node[]) => root.replaceChildren(...nodes)

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const n = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(n + '='.repeat((4 - (n.length % 4)) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

async function create(r: Extract<PasskeyRequest, { mode: 'create' }>): Promise<PasskeyOutcome> {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: RP_ID, name: RP_NAME },
      user: { id: new TextEncoder().encode(r.userId), name: r.userName, displayName: r.userName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 = P-256, what Safe verifies
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      timeout: 120_000,
    },
  }) as PublicKeyCredential | null
  if (!cred) return { status: 'error', message: 'Passkey setup was cancelled' }
  const spki = (cred.response as AuthenticatorAttestationResponse).getPublicKey?.()
  if (!spki) return { status: 'error', message: "This browser can't create a wallet passkey - update it or use another device" }
  const { x, y } = p256FromSpki(new Uint8Array(spki))
  return { status: 'created', credentialId: base64url(new Uint8Array(cred.rawId)), x: toHex(x, { size: 32 }), y: toHex(y, { size: 32 }) }
}

async function sign(r: Extract<PasskeyRequest, { mode: 'sign' }>): Promise<PasskeyOutcome> {
  const cred = await navigator.credentials.get({
    publicKey: {
      rpId: RP_ID,
      challenge: new Uint8Array(hexToBytes(r.challenge)),
      allowCredentials: [{ type: 'public-key', id: fromB64url(r.credentialId) }],
      userVerification: 'required',
      timeout: 120_000,
    },
  }) as PublicKeyCredential | null
  if (!cred) return { status: 'error', message: 'Face ID was cancelled' }
  const res = cred.response as AuthenticatorAssertionResponse
  const signature = encodePasskeySignature({
    authenticatorData: new Uint8Array(res.authenticatorData),
    clientDataJSON: new TextDecoder().decode(res.clientDataJSON),
    signature: new Uint8Array(res.signature),
  }, r.challenge)
  return { status: 'signed', signature }
}

function run(channel: BroadcastChannel, request: PasskeyRequest) {
  const isCreate = request.mode === 'create'
  const button = el('button', 'copy', isCreate ? 'Create passkey with Face ID' : 'Approve with Face ID')
  button.type = 'button'
  const note = el('p', 'muted', isCreate
    ? 'Your passkey stays in this device\'s secure chip. It is one of the two keys of your wallet.'
    : (request.mode === 'sign' && request.label) || 'Approve this with your passkey.')
  const finish = (outcome: PasskeyOutcome) => {
    channel.postMessage({ type: 'outcome', ticket, outcome })
    show(el('p', outcome.status === 'error' ? 'error' : 'muted', outcome.status === 'error' ? outcome.message : 'Done - you can close this.'))
  }
  button.onclick = async () => {
    button.disabled = true
    try {
      finish(isCreate ? await create(request) : await sign(request as Extract<PasskeyRequest, { mode: 'sign' }>))
    } catch (e) {
      const cancelled = e instanceof DOMException && e.name === 'NotAllowedError'
      finish({ status: 'error', message: cancelled ? 'Face ID was cancelled or not available' : (e instanceof Error ? e.message : 'Passkey failed') })
    }
  }
  show(note, button)
}

if (!/^0x[0-9a-f]{32}$/.test(ticket) || !window.PublicKeyCredential) {
  show(el('p', 'error', window.PublicKeyCredential ? 'This link has expired. Close it and try again.' : "This browser doesn't support passkeys."))
} else {
  let channel: BroadcastChannel | null = null
  try { channel = new BroadcastChannel(PASSKEY_CHANNEL) } catch { show(el('p', 'error', "This browser can't use passkeys here.")) }
  if (channel) {
    const timer = setTimeout(() => show(el('p', 'error', 'The wallet is not open. Close this and try again.')), 5000)
    channel.onmessage = (e) => {
      const d = e.data ?? {}
      if (d.type !== 'request' || d.ticket !== ticket) return
      clearTimeout(timer)
      if (d.error || !d.request) show(el('p', 'error', 'This link has expired. Close it and try again.'))
      else run(channel!, d.request as PasskeyRequest)
    }
    channel.postMessage({ type: 'claim', ticket })
  }
}
