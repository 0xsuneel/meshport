/**
 * chainRpcs.ts — compatibility re-export
 *
 * ── What this module is now ─────────────────────────────────────────────────
 * The per-destination-chain RPC fallback lists that used to be defined here
 * moved to src/blockchain/chains.ts (Phase 0 of
 * docs/BLOCKCHAIN_ARCHITECTURE_PROPOSAL.md), which is the single client-side
 * chain registry. This file stays as a thin re-export so its existing
 * importers — MultichainTransferPage.tsx and MultichainClaimPage.tsx — keep
 * working with no edit at all.
 *
 * Values are byte-identical to what was here before; only the definition site
 * changed. The per-endpoint incident history (Polygon's deprecated Amoy
 * endpoint, HyperEVM's unreliable node, the Ink/Morph/Edge SDK chain.name
 * mismatches) moved along with the data rather than being duplicated.
 *
 * ── Original reason this file existed ───────────────────────────────────────
 * RPC_BY_CHAIN_NAME was originally defined only inside MultichainClaimPage,
 * while MultichainTransferPage had no equivalent — its getProvider() trusted
 * whatever single endpoint the Circle SDK returned, with no fallback. If that
 * one destination RPC was slow or rate-limited during a non-forwarder mint,
 * the whole transfer stalled with nothing to fail over to. Extracting it here
 * gave both pages one shared list; moving it into the registry now extends
 * that same "one source of truth" property across the rest of the app.
 */

export {
  SDK_CHAIN_RPCS as RPC_BY_CHAIN_NAME,
  FORWARDER_SUPPORTED_SDK_CHAINS,
  chainSupportsForwarder,
} from '@/blockchain/chains'
