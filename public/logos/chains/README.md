# Chain Logo Sourcing

All chain logos live in `public/logos/chains/` as local SVG files — nothing
is hotlinked from an external URL anywhere in the app.

## Source

**[@web3icons/core](https://www.npmjs.com/package/@web3icons/core)** (MIT
licensed, npm package, actively maintained — version 4.0.51 at the time
these were downloaded). Extracted directly from the package's bundled SVG
data and re-optimized for this app (SVGO, 64×64 viewport, whitespace
stripped). Authenticity was spot-checked by confirming brand colors match
each chain's known official color (e.g. Monad's `#836EF9` purple, Arbitrum's
blue/white hexagon).

## Coverage — 22 of 22 chains have real official logos

| Chain | File | Status |
|---|---|---|
| Ethereum | `ethereum.svg` | ✅ official |
| Base | `base.svg` | ✅ official |
| Arbitrum | `arbitrum.svg` | ✅ official |
| Optimism | `optimism.svg` | ✅ official |
| Polygon | `polygon.svg` | ✅ official |
| Avalanche | `avalanche.svg` | ✅ official |
| Injective | `injective.svg` | ✅ official |
| Sei | `sei.svg` | ✅ official |
| Sonic | `sonic.svg` | ✅ official |
| World Chain | `world.svg` | ✅ official |
| Linea | `linea.svg` | ✅ official |
| Unichain | `unichain.svg` | ✅ official |
| Ink | `ink.svg` | ✅ official |
| Monad | `monad.svg` | ✅ official |
| Plume | `plume.svg` | ✅ official |
| XDC | `xdc.svg` | ✅ official |
| Codex | `codex.svg` | ✅ official |
| HyperEVM | `hyperevm.svg` | ✅ official |
| Arc | `arc.svg` | ✅ official (bonus — not currently wired up anywhere but available) |
| Pharos | `pharos.svg` | ✅ official (supplied directly, not from web3icons) |
| EDGE | `edge.svg` | ✅ official (supplied directly, not from web3icons) |
| Morph | `morph.svg` | ✅ official (supplied directly, not from web3icons) |

## Where these are used

- `src/features/multichain/MultichainClaimPage.tsx` — Claim screen
- `src/features/multichain/MultichainSendPage.tsx` — Transfer screen
- `src/components/ui/ClaimFundsWidget.tsx` — inline home-screen claim
  widget (currently not imported/rendered anywhere in the app, fixed for
  consistency in case it's wired up later)
- `src/features/insights/InsightsPage.tsx` — Insights/activity breakdown

Coin logos (USDC, EURC, cirBTC) in `SwapPage.tsx` and `HomePage.tsx` are a
separate, unrelated system and were left untouched — this task covered
chain logos only.
