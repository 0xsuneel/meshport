// The viem functions that code loads on demand (`await import('@/lib/viemLazy')`).
//
// `await import('viem')` hands the caller viem's whole namespace, so the
// bundler has to keep EVERY viem export - and `import('viem/accounts')` all ten
// recovery-phrase wordlists - in the viem file that Home downloads at start
// (~440 KB before compression). Named re-exports keep only what is used.
export {
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  parseGwei,
  parseSignature,
  recoverMessageAddress,
  toBytes,
  toHex,
} from 'viem'
export { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
