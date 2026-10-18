// src/lib/onchainNames.ts
//
// On-chain usernames (MeshPortNames on Arc testnet, foundry/src/MeshPortNames.sol).
//
// Sign-up starts with a choice - personal account or business - kept here
// for the rest of the flow (it survives the Google redirect, which returns
// to the same tab). After the username is saved in Supabase as before, the
// user signs an EIP-712 Register request with their own wallet key and the
// name-register edge function sends it from the registrar wallet, so the
// user pays no gas and the registrar can't register a name for anyone else.
//
// The on-chain step never blocks sign-up: if it fails, the signed request is
// kept server-side and retried by the name-register sync job.

import { supabase } from './supabase'
import { getSessionPrivateKey } from './security'

export type AccountKind = 'personal' | 'business'

const SIGNUP_KIND_KEY = 'meshport_signup_kind'
const DEADLINE_SEC = 7 * 24 * 60 * 60

// Create account or Log in - picked on the same first screen as the type.
// Missing = 'create' (sign-ins started before this existed behave as before).
const AUTH_MODE_KEY = 'meshport_auth_mode'

export function setSignupKind(kind: AccountKind | null) {
  try {
    if (kind) sessionStorage.setItem(SIGNUP_KIND_KEY, kind)
    else sessionStorage.removeItem(SIGNUP_KIND_KEY)
  } catch { /* storage unavailable */ }
}

/** The account type picked on the first screen (Create account or Log in), or null. */
export function getChosenKind(): AccountKind | null {
  try {
    const v = sessionStorage.getItem(SIGNUP_KIND_KEY)
    return v === 'business' || v === 'personal' ? v : null
  } catch { return null }
}

/** The account type picked for a NEW account, or null (log in / not chosen). */
export function getSignupKind(): AccountKind | null {
  return getAuthMode() === 'create' ? getChosenKind() : null
}

export function getAuthMode(): 'create' | 'login' {
  try { return sessionStorage.getItem(AUTH_MODE_KEY) === 'login' ? 'login' : 'create' } catch { return 'create' }
}

/** Create account / Log in plus the chosen type, kept across the Google redirect. */
export function setAuthIntent(mode: 'create' | 'login', kind: AccountKind | null) {
  try { sessionStorage.setItem(AUTH_MODE_KEY, mode) } catch { /* storage unavailable */ }
  setSignupKind(kind)
}

/** Forget the choice once signed in (or signed up). */
export function clearAuthIntent() {
  try { sessionStorage.removeItem(AUTH_MODE_KEY) } catch { /* storage unavailable */ }
  setSignupKind(null)
}

const KIND_INDEX: Record<AccountKind, number> = { personal: 0, business: 1 }

export type OnchainNameResult =
  | { status: 'registered' | 'pending'; txHash?: string }
  | { status: 'failed' | 'unavailable' | 'no-key'; error?: string }

/**
 * Signs and submits the on-chain registration of `name` for `walletAddress`.
 * The username must already be saved in Supabase for this wallet.
 */
export async function registerNameOnchain(p: {
  walletAddress: string
  name: string
  kind: AccountKind
  displayName?: string
}): Promise<OnchainNameResult> {
  const pk = await getSessionPrivateKey(p.walletAddress)
  if (!pk) return { status: 'no-key' }

  const { data: info, error: infoErr } = await supabase.functions.invoke('name-register', {
    body: { action: 'nonce', wallet: p.walletAddress },
  })
  if (infoErr || !info?.contract) return { status: 'unavailable' }

  const displayName = (p.displayName ?? '').trim()
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SEC)
  const { privateKeyToAccount } = await import('viem/accounts')
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : '0x' + pk) as `0x${string}`)
  if (account.address.toLowerCase() !== p.walletAddress.toLowerCase()) return { status: 'no-key' }

  const signature = await account.signTypedData({
    domain: { name: 'MeshPortNames', version: '1', chainId: Number(info.chainId), verifyingContract: info.contract },
    types: {
      Register: [
        { name: 'name', type: 'string' },
        { name: 'account', type: 'address' },
        { name: 'kind', type: 'uint8' },
        { name: 'displayName', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Register',
    message: {
      name: p.name, account: account.address, kind: KIND_INDEX[p.kind],
      displayName, nonce: BigInt(info.nonce), deadline,
    },
  })

  const { data, error } = await supabase.functions.invoke('name-register', {
    body: {
      action: 'register', wallet: account.address, name: p.name, kind: p.kind,
      displayName, deadline: deadline.toString(), signature,
    },
  })
  if (error) return { status: 'failed', error: data?.error ?? error.message }
  if (data?.status === 'registered' || data?.status === 'pending') return { status: data.status, txHash: data.txHash }
  return { status: 'failed', error: data?.error }
}

/** Where this wallet's name stands on-chain (none / pending / registered / failed). */
export async function onchainNameStatus(walletAddress: string): Promise<string> {
  const { data } = await supabase.functions.invoke('name-register', { body: { action: 'status', wallet: walletAddress } })
  return typeof data?.status === 'string' ? data.status : 'none'
}
