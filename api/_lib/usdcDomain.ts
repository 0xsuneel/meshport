// api/_lib/usdcDomain.ts
//
// The EIP-712 domain a chain's USDC really verifies EIP-3009 signatures with.
//
// The app signs a transfer authorization with a domain (name, version,
// chainId, token). USDC rejects it ("FiatTokenV2: invalid signature") if any
// part differs from what the contract hashed into its DOMAIN_SEPARATOR. The
// relay used to take name and version from name() / version(), which is not
// always what the separator was built from. Here the answer comes from the
// contract itself: a candidate (name, version) is accepted only when it hashes
// to the token's own DOMAIN_SEPARATOR().
import { hashDomain } from 'viem'

export const DOMAIN_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
} as const

export function usdcDomainSeparator(name: string, version: string, chainId: number, token: `0x${string}`): `0x${string}` {
  return hashDomain({ domain: { name, version, chainId: BigInt(chainId), verifyingContract: token }, types: DOMAIN_TYPES })
}

/**
 * The (name, version) whose separator equals `onChain`, trying what the token
 * reports first, then the names and versions Circle's USDC is known to use.
 * Null when none matches - the caller must not hand out a signing domain then.
 */
export function matchUsdcDomain(
  onChain: string, chainId: number, token: `0x${string}`, reported: { name: string; version: string },
): { name: string; version: string } | null {
  const names = [...new Set([reported.name, 'USDC', 'USD Coin'])]
  const versions = [...new Set([reported.version, '2', '1'])]
  const want = onChain.toLowerCase()
  for (const name of names) for (const version of versions)
    if (usdcDomainSeparator(name, version, chainId, token).toLowerCase() === want) return { name, version }
  return null
}
