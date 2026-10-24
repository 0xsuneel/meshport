// src/wallet/safe/addresses.ts
//
// Official Safe deployments the MeshPort account is built from, all verified
// live on Arc testnet (eth_getCode, 2026-10-24). Addresses are the canonical
// deterministic ones from safe-global/safe-smart-account and
// safe-global/safe-modules (CHANGELOGs) - the same on every chain that has them.
//
// Nothing here is MeshPort-written contract code: the account is a stock
// Safe 1.4.1 with stock, audited modules.

import type { Hex } from '../protocol'

export const SAFE = {
  /** SafeL2 1.4.1 singleton - emits events MeshPort's indexer follows. */
  singletonL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  /** ERC-4337 for EntryPoint v0.7; also the Safe's fallback handler. */
  module4337: '0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226',
  /** delegatecalled from setup() to enable modules at creation. */
  moduleSetup: '0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47',
  /** Passkey owners: one tiny signer contract per passkey (x, y, verifiers). */
  webAuthnSignerFactory: '0x1d31F259eE307358a26dFb23EB365939E8641195',
  /** Solidity P-256 verifier, used if the precompile is ever unavailable. */
  fclP256Verifier: '0xA86e0054C51E4894D88762a017ECc5E5235f5DBA',
  /** Spending limits per delegate (the version deployed on Arc). */
  allowanceModule: '0xAA46724893dedD72658219405185Fb0Fc91e091C',
  /** Candide social recovery (guardians + delay), formally verified by Safe. */
  socialRecoveryModule: '0x4Aa5Bf7D840aC607cb5BD3249e6Af6FC86C04897',
  entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
} as const satisfies Record<string, Hex>

/** Arc's RIP-7212 P-256 precompile (verified: valid sig → 1). */
export const ARC_P256_PRECOMPILE = 0x100n
