# Phase 0 + Phase 1 — Verification Record

Tag: `phase-1-complete` → commit `857ea61`
Network: **Arc Testnet / Circle Testnet only.** No mainnet endpoint, key or
contract was introduced at any point.

---

## What I verified automatically

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vite build` | exit 0 |
| Code-splitting preserved | `ethers` / `viem` / `circle-sdk` remain separate chunks |
| Phase 0 standalone | typechecks + builds with Phase 1 files removed |
| Phase 1 unit harness | 27 / 27 |
| Baseline equivalence harness | 133 / 134 constants byte-identical |

**Baseline equivalence** is the strongest evidence that Phase 0 preserved
behaviour. Every chain id, token contract, decimals value, RPC list and
forwarder flag was imported from the pristine baseline commit (`0fcbc58`) and
compared against today's value at runtime. Both harnesses were deleted after
use — the repo has no test framework to keep them in.

The single intentional difference is documented in commit `857ea61`: a circular
import between `arc.ts` and `arcService.ts` meant
`ARC_CHAIN_INLINE.rpcUrls.default.http` was `undefined` at runtime in the
original code. Dormant — that object is only ever passed as viem's `chain:`
argument (chain id + signing metadata), never used for transport.

---

## What I could NOT verify — manual sign-off required

**There is no `.env` in this working copy**, so the app cannot be started here.
The following have **not** been exercised end-to-end and must be confirmed
against testnet before Phase 2 begins:

- [ ] Wallet creation (new BIP39 seed phrase)
- [ ] Wallet import (seed phrase + private key)
- [ ] Login / passcode unlock / biometric unlock
- [ ] Arc USDC balance displays correctly on Home
- [ ] EURC + cirBTC balances display correctly
- [ ] Send USDC → recipient receives, Activity row appears
- [ ] Send EURC → same
- [ ] Swap (USDC ↔ EURC / cirBTC)
- [ ] Multichain Hub — external balances match Home's unified total
- [ ] Claim funds from an external chain → lands on Arc, Activity updated
- [ ] Multichain Send (bridge out) → arrives on destination chain
- [ ] Chat — send/receive message, in-chat payment
- [ ] Contacts — pay a saved contact
- [ ] Treasury page renders (no blockchain calls — lowest risk)
- [ ] Bulk payout
- [ ] P2P escrow (deposit / release)
- [ ] Rewards claim
- [ ] Deposit detection — send from an external wallet, confirm it appears

### Why the risk is low, stated precisely

- **Phase 1 is entirely unwired.** Nothing imports `src/blockchain/*` or the new
  store modules. Those files cannot affect runtime behaviour.
- **Phase 0 is relocation + re-export.** No call site changed; the equivalence
  harness confirms the values are identical.
- **Deleted files had zero importers** — verified by grep across the whole repo.

Low is not zero. Constants can be right while wiring is wrong, and only a real
device on real testnet proves that.

### Highest-value spot checks

If a full pass isn't practical, these three exercise the most changed surface:

1. **Home loads with correct USDC/EURC/cirBTC balances** — exercises `arc.ts`,
   `arcService.ts`, `chains.ts` and the token registry together.
2. **One USDC send completes** — exercises `ARC_CHAIN_INLINE`, gas estimation,
   nonce handling and signing, i.e. the constants that would move real funds.
3. **Multichain Hub lists external balances** — exercises `EXTERNAL_CHAINS`,
   the 21-chain scan, and the reordered HyperEVM entry.

---

## How to run it

```bash
cp .env.example .env     # then fill in real testnet values
npm run dev
```

## If something is wrong

Every commit is independently revertible:

```bash
git revert 4ce748a   # HyperEVM reorder only
git revert c122990   # Phase 1 foundation only
git revert aa67590   # Phase 0 registry only
git reset --hard 0fcbc58   # back to the pristine archive
```

---

## Phase 2 readiness

Phase 2 routes Home / Hub / Claim reads through `BlockchainManager`. It is the
first phase to modify live read paths, so the checklist above should be signed
off first — it is also the natural "before" baseline for confirming Phase 2
changed nothing user-visible.

Two open questions from the proposal (§27) still affect projected numbers but
do not block the work: the intended mainnet chain set, and the current Alchemy
plan/CU budget.
