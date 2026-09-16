# Chain Transfer Webhook — one-time setup

This is the setup for the real-time Receive fix (Tier 1). The code
(`supabase/functions/chain-transfer-webhook`) is already built and deployed.
This document is the remaining setup that requires **your own Circle
account** — I don't have Circle API access from this environment, so this
part has to be you.

## What this actually fixes

Traced this session, with real production data: MeshPort had zero push
mechanism for incoming transfers. Every detection path was pull-based
(scan-on-app-open or cron-scheduled). Real wallets (MetaMask, Trust, Coinbase)
don't scan faster — they receive a push the instant their RPC provider sees
a matching transfer mined. Circle ships the exact same primitive natively for
Arc: **Event Monitoring**. This setup registers your USDC/EURC/cirBTC
contracts with Circle, so Circle pushes a webhook to MeshPort the moment a
Transfer happens — no scanning, no waiting for the app to be open.

## Prerequisites

1. A Circle Developer account with access to the **Contracts** product
   (separate from any CCTP-related Circle access this project may already
   have — Contracts/Event Monitoring is its own product with its own API
   key). Sign up / log in at [console.circle.com](https://console.circle.com).
2. In the Circle Console, create an **API key** for the Contracts product,
   and generate/register an **Entity Secret** if you haven't already
   (Console → Contracts → API Keys). You'll get:
   - `CIRCLE_API_KEY`
   - `CIRCLE_ENTITY_SECRET`

## Step 1 — Set the Supabase secret

The webhook function needs your API key to fetch Circle's public key for
signature verification (it does NOT need the entity secret — that's only for
the one-time registration script below, run from your own machine, not
stored in Supabase).

```
supabase secrets set CIRCLE_API_KEY=<your key> --project-ref cvvpzfvzweszuuxvaayb
```

## Step 2 — Configure the webhook endpoint in Circle Console

Circle Console → Webhooks (or Notifications) → Add endpoint:

- **URL:** `https://cvvpzfvzweszuuxvaayb.supabase.co/functions/v1/chain-transfer-webhook`
- Under **Limit to specific events**, select **`contracts.EventLog`** only —
  no need to receive every Circle notification type at this endpoint.

Circle's console will show you a **Webhook Signing** section — you don't
need to copy a shared secret here (unlike some other webhook providers);
Circle signs with an asymmetric key per notification (`X-Circle-Signature` +
`X-Circle-Key-Id`), and the function verifies it live against Circle's own
public key endpoint, using the `CIRCLE_API_KEY` you set in Step 1.

## Step 3 — Import the 3 token contracts and create event monitors

Run this once, from your own machine (needs Node.js). It imports each
contract into Circle's Contracts platform (required before a monitor can be
created) and creates a `Transfer(address,address,uint256)` event monitor for
each — the exact 3 contracts `chain-transfer-webhook` already watches, so
these addresses must match exactly.

```bash
npm install @circle-fin/smart-contract-platform
```

```javascript
// register-arc-transfer-monitors.mjs
import { initiateSmartContractPlatformClient } from '@circle-fin/smart-contract-platform'
import { randomUUID } from 'crypto'

const scp = initiateSmartContractPlatformClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
})

// Must match chain-transfer-webhook/index.ts's WATCHED_TOKENS exactly.
const TOKENS = [
  { name: 'USDC (Arc native ERC-20 view)', address: '0x3600000000000000000000000000000000000000' },
  { name: 'EURC',                          address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' },
  { name: 'cirBTC',                        address: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' },
]

for (const token of TOKENS) {
  console.log(`Importing ${token.name} (${token.address})...`)
  try {
    await scp.importContract({
      address: token.address,
      blockchain: 'ARC-TESTNET',
      idempotencyKey: randomUUID(),
      name: token.name,
      description: `MeshPort watched token: ${token.name}`,
    })
  } catch (e) {
    // Already imported is fine — everything else, stop and look at it.
    if (!String(e?.message || e).includes('already')) throw e
    console.log(`  (already imported, continuing)`)
  }

  console.log(`Creating Transfer event monitor for ${token.name}...`)
  const monitor = await scp.createEventMonitor({
    blockchain: 'ARC-TESTNET',
    contractAddress: token.address,
    eventSignature: 'Transfer(address,address,uint256)',
    idempotencyKey: randomUUID(),
  })
  console.log(`  monitor id: ${monitor.data.eventMonitor.id}`)
}

console.log('Done. Send a small USDC/EURC/cirBTC transfer to a MeshPort wallet to test.')
```

```bash
CIRCLE_API_KEY=<your key> CIRCLE_ENTITY_SECRET=<your entity secret> node register-arc-transfer-monitors.mjs
```

## Step 4 — Verify it's actually working

1. Send a small amount of USDC, EURC, or cirBTC to a MeshPort wallet from any
   external wallet (MetaMask, OKX, whatever).
2. Check the function logs (`supabase functions logs chain-transfer-webhook`
   or via the Supabase Dashboard) — you should see a request land within a
   few seconds of the transfer confirming, and either `"recorded": true` or
   a clear `"ignored"` reason.
3. If `chain-transfer-webhook` never receives anything at all: double-check
   the webhook URL and the `contracts.EventLog` event-type filter in Circle
   Console, and confirm the event monitors from Step 3 show
   `"isEnabled": true`.
4. Existing scan-based paths (`claim-recovery-scan`, `activity-consumer`,
   `blockchain-indexer`) are untouched and still running as a backstop — if
   the webhook path has an issue, Receive will still show up, just back at
   the old latency, not disappear entirely.

## What this does not cover

Circle's Event Monitoring only fires for events actually **emitted** by a
watched contract. If a transfer mechanism ever moves funds without touching
one of these 3 contracts' Transfer log, this webhook won't see it — that's
exactly why the existing scan-based paths are staying in place as a
backstop, not being removed.

### cirBTC — registered live status, real known gap

USDC and EURC are both live (registered 2026-08-30, `isEnabled: true`, verified directly
against Circle's API). **cirBTC's event monitor could not be created**:

```
{"code":175303,"message":"The specified event signature does not exist"}
```

Circle's own docs explain this happens when they can't independently verify a
`Transfer(address,address,uint256)` event actually exists on a contract they
haven't auto-recognized. This lines up with cirBTC being faucet-distributed
rather than something people commonly send each other peer-to-peer from an
external wallet — the exact real-world case (someone sends you money from
MetaMask/OKX/etc.) this fix targets barely applies to cirBTC in practice, so
this is a real but low-impact gap, not a bug worth chasing further right now.

cirBTC receives keep using the existing scan-based path
(`claim-recovery-scan`/`activity-consumer`) exactly as before — nothing
regressed, it simply didn't get the speed-up USDC/EURC did. If this ever
needs revisiting: check Contracts → "MeshportCirbtc" in Circle Console for a
manual verify/ABI-override option, or ask Circle support directly with the
contract address (`0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF`,
ARC-TESTNET) and this exact error code.
