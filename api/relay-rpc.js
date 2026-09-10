/**
 * /api/relay-rpc — Gas-sponsoring JSON-RPC proxy
 *
 * The relay pays gas by checking user ETH balance first.
 * If user has enough ETH → submit their signed tx directly (no funding needed)
 * If user has no ETH → fund exact deficit, then submit
 * This eliminates the failing "fund user" step in most cases.
 */

// Alchemy API key — set ALCHEMY_KEY in Vercel environment variables
const ALCHEMY_KEY = process.env.ALCHEMY_KEY ?? ''
const A = ALCHEMY_KEY  // shorthand

// drpc.live API key — set DRPC_KEY in Vercel environment variables
const DRPC_KEY = process.env.DRPC_KEY ?? ''
const D = DRPC_KEY  // shorthand

const CHAIN_DEFS = {
  Ethereum_Sepolia: { rpcs: [
    `https://eth-sepolia.g.alchemy.com/v2/${A || 'demo'}`,
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://ethereum-sepolia.blockpi.network/v1/rpc/public',
    'https://sepolia.gateway.tenderly.co',
    'https://rpc.sepolia.org',
    'https://rpc2.sepolia.org',
  ]},
  Base_Sepolia: { rpcs: [
    `https://base-sepolia.g.alchemy.com/v2/${A || 'demo'}`,
    'https://base-sepolia-rpc.publicnode.com',
    'https://sepolia.base.org',
    'https://base-sepolia.blockpi.network/v1/rpc/public',
  ]},
  Arbitrum_Sepolia: { rpcs: [
    `https://arb-sepolia.g.alchemy.com/v2/${A || 'demo'}`,
    'https://arbitrum-sepolia-rpc.publicnode.com',
    'https://sepolia-rollup.arbitrum.io/rpc',
    'https://arbitrum-sepolia.blockpi.network/v1/rpc/public',
  ]},
  Optimism_Sepolia: { rpcs: [
    `https://op-sepolia.g.alchemy.com/v2/${A || 'demo'}`,
    'https://optimism-sepolia-rpc.publicnode.com',
    'https://sepolia.optimism.io',
    'https://optimism-sepolia.blockpi.network/v1/rpc/public',
  ]},
  Polygon_Sepolia: { rpcs: [
    `https://lb.drpc.live/polygon-amoy/${D}`,
    `https://polygon-amoy.g.alchemy.com/v2/${A || 'demo'}`,
    'https://polygon-amoy-bor-rpc.publicnode.com',
  ]},
  Avalanche_Fuji: { rpcs: [
    'https://api.avax-test.network/ext/bc/C/rpc',
    'https://avalanche-fuji-c-chain-rpc.publicnode.com',
  ]},
  HyperEVM_Testnet:    { rpcs: [
    'https://api.hyperliquid-testnet.xyz/evm',
    'https://rpc.hyperliquid-testnet.xyz/evm',
    'https://hyperliquid-testnet.rpc.thirdweb.com',
  ]},
  Sei_Testnet:         { rpcs: [
    `https://lb.drpc.live/sei-testnet/${D}`,
    'https://evm-rpc-testnet.sei-apis.com',
    'https://sei-testnet.rpc.thirdweb.com',
  ]},
  Sonic_Testnet:       { rpcs: [
    'https://rpc.testnet.soniclabs.com',
    'https://sonic-testnet.rpc.thirdweb.com',
  ]},
  Unichain_Sepolia:    { rpcs: [
    `https://unichain-sepolia.g.alchemy.com/v2/${A || 'demo'}`,
    'https://sepolia.unichain.org',
  ]},
  World_Chain_Sepolia: { rpcs: [
    'https://worldchain-sepolia.g.alchemy.com/public',
    'https://worldchain-sepolia.rpc.thirdweb.com',
  ]},
  // The 10 chains below were completely missing from this allowlist — any
  // claim on one of them that needed gas-sponsorship (i.e. the user's
  // wallet had zero native gas token on that chain, true for nearly every
  // testnet nobody manually funds) hit `if (!chain) return 400` in the
  // handler at the bottom of this file, immediately failing with
  // "Unknown chain: X" before ever reaching the actual RPC. RPCs below are
  // verified directly against @circle-fin/bridge-kit's own shipped chain
  // definitions (installed and inspected directly), not from web search.
  Linea_Sepolia: { rpcs: [
    'https://rpc.sepolia.linea.build',
  ]},
  Ink_Testnet: { rpcs: [
    'https://rpc-gel-sepolia.inkonchain.com',
    'https://rpc-qnd-sepolia.inkonchain.com',
  ]},
  Monad_Testnet: { rpcs: [
    `https://lb.drpc.live/monad-testnet/${D}`,
    'https://testnet-rpc.monad.xyz',
  ]},
  Morph_Testnet: { rpcs: [
    'https://rpc-hoodi.morphl2.io',
  ]},
  Pharos_Testnet: { rpcs: [
    'https://atlantic.dplabs-internal.com',
  ]},
  Plume_Testnet: { rpcs: [
    'https://testnet-rpc.plume.org',
  ]},
  XDC_Apothem: { rpcs: [
    'https://erpc.apothem.network',
  ]},
  Codex_Testnet: { rpcs: [
    'https://rpc.codex-stg.xyz',
  ]},
  Edge_Testnet: { rpcs: [
    'https://edge-testnet.g.alchemy.com/public',
  ]},
  Injective_Testnet: { rpcs: [
    'https://k8s.testnet.json-rpc.injective.network',
  ]},
}

const GAS_BY_SELECTOR = {
  // 65,000 was too tight — a real Polygon Amoy claim used 64,578 of 65,000
  // (99.4%) then reverted out of gas. Raised to 120,000, then to 250,000 —
  // but that never actually fixed Monad, Sei, or Polygon Amoy (on V2),
  // because the deeper bug was here the whole time: the hardcoded
  // depositForBurn v2 selector below was WRONG. V2's real function
  // signature is depositForBurn(uint256,uint32,bytes32,address,bytes32,
  // uint256,uint32) — 7 parameters, not V1's 4 — which hashes to a
  // completely different selector. The old value here never matched a
  // real V2 transaction, so every V2 burn silently fell through every
  // fallback below (CIRCLE_CONTRACTS, then USDC_CONTRACTS) down to the
  // generic "unknown selector" default of 150,000 gas — regardless of how
  // high this map's own V2 entry was set. Monad and Sei ONLY support V2
  // (no V1 contracts in their chain config at all), so 100% of their burns
  // hit this. Polygon Amoy has both, but hits the same bug whenever the
  // SDK uses its V2/fast path. Selectors below verified by computing
  // keccak256 of the actual function signatures directly, not assumed.
  '0x095ea7b3': '0x3d090',  // ERC20 approve:                     250,000
  '0x39509351': '0x3d090',  // ERC20 increaseAllowance:           250,000 (Circle SDK uses this)
  '0x6fd3504e': '0x7a120',  // depositForBurn v1 (4 params):      500,000
  '0x8e0250ee': '0x9eb10',  // depositForBurn v2 (7 params):      650,000  — was 0x8a94d4fc (WRONG, never matched); raised from 500,000 after a real V2 burn still needed margin
  '0xf856ddb6': '0x7a120',  // depositForBurnWithCaller v1:       500,000
  '0x779b432d': '0x9eb10',  // depositForBurnWithHook v2:         650,000  — was 0x44bc937b (WRONG, never matched); raised from 500,000, same reasoning as depositForBurn v2 above
  '0x57ecfd28': '0x9eb10',  // receiveMessage (spend):            650,000  (was 550,000)
  // ── bridgeWithPreapprovalAndHook and its 650k→700k history ─────────────────
  // Read directly out of the installed SDK source
  // (node_modules/@circle-fin/provider-cctp-v2@1.10.1 and
  // @circle-fin/adapter-ethers-v6), not assumed: `depositForBurn`/
  // `depositForBurnWithHook` above are prepared by provider-cctp-v2's
  // "standard" flow, which passes its OWN hardcoded gasLimit override
  // (DEPOSIT_FOR_BURN_GAS_LIMIT_EVM = 300_000n, "observed max 226,506 +
  // ~30%") straight to execute() — that flow never calls eth_estimateGas at
  // all, so this file's entries for those two selectors are consulted only
  // on chains where the SDK's "custom" (Kit bridge) flow ISN'T selected.
  // But `hasCustomContractSupport(chain,'bridge')` — checked BEFORE
  // isCCTPV2Supported, so it wins whenever kitContracts.bridge is set —
  // routes to the 'custom' flow instead, which builds one of
  // bridgeWithPreapproval(AndHook)/bridgeWithPermit(AndHook) in
  // adapter-ethers-v6, and THAT flow calls the adapter's real
  // `contractFunction.estimateGas(...)` — i.e. THIS proxy's hardcoded
  // eth_estimateGas response IS what ends up as the signed tx's gasLimit.
  // kitContracts.bridge is configured broadly across testnet chain
  // definitions (not just these three), so every claim likely goes through
  // this exact selector — it just only actually needs more than 700,000 gas
  // on Polygon Amoy, Monad and Sei specifically. Those three run
  // meaningfully different EVM execution environments (Sei's Cosmos-SDK EVM
  // compatibility layer, Monad's from-scratch parallelized execution
  // engine, Polygon's Bor client) where the identical bytecode can cost
  // more real gas units than on an OP-stack/Arbitrum-Nitro-style L2 — which
  // is exactly consistent with 18 of 21 chains working fine at 700,000 gas
  // while these three don't.
  //
  // eth_sendRawTransaction below funds `gasLimit × gasPrice` DECODED FROM
  // THE ACTUAL SIGNED TX — not a guess — so "relay providing gas" and
  // "claim failing" are NOT contradictory: the relay correctly funds
  // exactly enough ETH to cover whatever (too-low) gasLimit got signed in,
  // the transaction still runs out of gas mid-execution, and the funding
  // step has no way to know the limit itself was insufficient.
  //
  // Raised from 700,000 to 1,500,000 — a gas LIMIT ceiling costs nothing
  // unused (only gas actually consumed is paid for), so there's no downside
  // to a wide margin here, only downside to being short again.
  '0x35093510': '0x16e360', // (kept as a guess, unverified) — was labeled "Kit Bridge contract burn" but never actually matched a real tx on any chain — 1,500,000
  '0x513e1175': '0x16e360', // bridgeWithPreapprovalAndHook(tuple bridgeParams, bytes hookData) — the REAL selector for the Kit Bridge contract call, confirmed directly from a decoded Polygon Amoy tx's Input Data (MethodID) — 1,500,000
}
const CIRCLE_CONTRACTS = new Set([
  '0x0077777d7eba4688bdef3e311b846f25870a19b9',
  '0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5',
  '0x7865fafc2db2093669d92c0f33aeef291086befd',  // was '...086becd' — typo, verified against the real SDK value
  '0xacf1ceef35caac005e15888ddb8a3515c41b4872',
  '0xc5567a5e3370d4dbfb0540025078e283e36a363d',  // Kit Bridge Contract testnet
  '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',  // Kit Adapter Contract testnet
  '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',  // CCTP V2 TokenMessenger — same address across all 21 chains, safety net for any V2 selector variant not in GAS_BY_SELECTOR
  '0xe737e5cebeeba77efe34d4aa090756590b1ce275',  // CCTP V2 MessageTransmitter — same reasoning
])

// USDC addresses — any estimateGas call to these returns 65k (approve/increaseAllowance)
const USDC_CONTRACTS = new Set([
  '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', // Ethereum Sepolia
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e', // Base Sepolia
  '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', // Arbitrum Sepolia
  '0x5fd84259d66cd46123540766be93dfe6d43130d7', // Optimism Sepolia
  '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582', // Polygon Amoy
  '0x5425890298aed601595a70ab815c96711a31bc65', // Avalanche Fuji
  '0x2b3370ee501b4a559b57d449569354196457d8ab', // HyperEVM
  '0x4fcf1784b31630811181f670aea7a7bef803eaed', // Sei
  '0x0ba304580ee7c9a980cf72e55f5ed2e9fd30bc51', // Sonic — was 0xa4879fed...c4ec6, the same stale/wrong contract found and fixed on the Hub page earlier
  '0x31d0220469e10c4e71834a79b1f276d740d3768f', // Unichain
  '0x66145f38cbac35ca6f1dfb4914df98f1614aea88', // World Chain — was 0x79a02482...4cd24d1, same stale-address bug as Sonic above
  '0xfece4462d57bd51a6a552365a011b95f0e16d9b7', // Linea Sepolia
  '0xfabab97dce620294d2b0b0e46c68964e326300ac', // Ink Testnet
  '0x534b2f3a21130d7a60830c2df862319e593943a3', // Monad Testnet — previously missing entirely
  '0x7433b41c6c5e1d58d4da99483609520255ab661b', // Morph Testnet
  '0xcfc8330f4bcab529c625d12781b1c19466a9fc8b', // Pharos Testnet
  '0xcb5f30e335672893c7eb944b374c196392c19d18', // Plume Testnet
  '0xb5ab69f7bbada22b28e79c8ffaece55ef1c771d4', // XDC Apothem
  '0x6d7f141b6819c2c9cc2f818e6ad549e7ca090f8f', // Codex Testnet
  '0x2d9f7cad728051aa35ecdc472a14cf8cdf5cfd6b', // Edge Testnet
  '0x0c382e685bbeefe5d3d9c29e29e341fee8e84c5d', // Injective Testnet
])

// No fixed minimum — we decode the actual tx to get exact gas cost

async function rpc(rpcs, method, params = [], id = 1) {
  const urls = Array.isArray(rpcs) ? rpcs : [rpcs]
  let lastError
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(20000),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const json = await r.json()
      if (json.error) {
        // Bug fix: this used to do `throw new Error(json.error.message)`,
        // discarding json.error.data (and .code) entirely — for a reverted
        // eth_call/eth_estimateGas, that's exactly where the real,
        // specific revert reason usually lives (a require() message, or a
        // custom error selector + encoded args). Collapsing this to a bare
        // string meant Circle's SDK could never decode anything specific
        // from what we handed back, so every claim failure surfaced as
        // the same generic "Transaction reverted" no matter what actually
        // went wrong on-chain — completely opaque, and impossible to
        // diagnose from the client side. Preserving the full error object
        // as properties on the thrown Error (not just its message) lets
        // the pass-through section below forward it intact.
        const err = new Error(json.error.message ?? JSON.stringify(json.error))
        err.code = json.error.code
        err.data = json.error.data
        throw err
      }
      return json
    } catch (e) {
      lastError = e
      console.warn(`[relay-rpc] ${url.split('/')[2]} failed: ${e.message.slice(0,50)}`)
    }
  }
  throw lastError ?? new Error('All RPCs failed')
}

async function sendSignedTx(rpcs, relayKey, to, data, value = 0n) {
  const { ethers } = require('ethers')
  const relay = new ethers.Wallet(relayKey)
  const [nonceRes, gpRes, chainRes] = await Promise.all([
    rpc(rpcs, 'eth_getTransactionCount', [relay.address, 'pending']),
    rpc(rpcs, 'eth_gasPrice'),
    rpc(rpcs, 'eth_chainId'),
  ])
  const nonce    = parseInt(nonceRes.result, 16)
  const gasPrice = BigInt(gpRes.result) * 130n / 100n
  const chainId  = parseInt(chainRes.result, 16)
  const signed   = await relay.signTransaction({ to, value, data, gasLimit: 21000n, gasPrice, nonce, chainId, type: 0 })
  const res      = await rpc(rpcs, 'eth_sendRawTransaction', [signed])
  return res.result
}

async function waitReceipt(rpcs, txHash, max = 30) {
  for (let i = 0; i < max; i++) {
    await new Promise(r => setTimeout(r, 2000))
    try {
      const res = await rpc(rpcs, 'eth_getTransactionReceipt', [txHash])
      if (res.result?.blockNumber) return true
    } catch {}
  }
  return false
}

// Shared by both eth_sendRawTransaction (funds for the exact real cost of
// the signed tx) and the new eth_call pre-flight check below (funds a
// conservative flat buffer, since a simulate call has no signed
// gasLimit/gasPrice to decode the real cost from). Returns { error: null,
// fundedWei } on success (fundedWei is 0n if the user's wallet already had
// enough — MeshPort only ever transfers the real shortfall, never the full
// requiredWei again), or { error: <JSON-RPC error object> } if funding was
// needed but didn't confirm.
async function ensureFunded(rpcs, relayKey, userAddr, requiredWei, id) {
  const { ethers } = require('ethers')
  let userEth = 0n
  try {
    const balRes = await rpc(rpcs, 'eth_getBalance', [userAddr, 'pending'])
    userEth = BigInt(balRes.result ?? '0x0')
  } catch {}
  if (userEth >= requiredWei) return { error: null, fundedWei: 0n }
  const deficit = (requiredWei - userEth) * 120n / 100n // 20% buffer for gas price fluctuation
  console.log(`[relay-rpc] funding deficit+buffer: ${deficit} wei (${ethers.formatEther(deficit)} ETH)`)
  const fundHash = await sendSignedTx(rpcs, relayKey, userAddr, '0x', deficit)
  console.log(`[relay-rpc] fund tx: ${fundHash} — waiting...`)
  const funded = await waitReceipt(rpcs, fundHash)
  if (!funded) {
    console.error(`[relay-rpc] funding tx ${fundHash} did not confirm within timeout`)
    return { error: { jsonrpc: '2.0', id, error: { code: -32603, message: `Gas funding transaction ${fundHash} did not confirm in time — please retry` } } }
  }
  console.log(`[relay-rpc] ✓ funded`)
  return { error: null, fundedWei: deficit }
}

async function handleOne(item, rpcs, relayKey, userAddr) {
  const method = item?.method
  const params = item?.params ?? []
  const id     = item?.id ?? 1

  // ── mp_ensureGasFunded: explicit, unconditional pre-funding ────────────────
  // Not a real Ethereum JSON-RPC method — a MeshPort-specific one the client
  // calls directly, deliberately, before ever invoking kit.bridge(). Added
  // after eth_call-based pre-funding (below) didn't fix a real production
  // case: a burn transaction that never even reached the chain (confirmed
  // by checking the wallet's actual on-chain history — every past
  // transaction was an Increase Allowance, never a depositForBurn/
  // bridgeWithPreapprovalAndHook), while the SDK reported "Simulation
  // failed: Transaction reverted". That means whatever internal check the
  // SDK runs before signing didn't go through the eth_call path this file
  // intercepts — it uses some other internal RPC call this proxy was never
  // going to reliably catch by guessing at method names. Rather than keep
  // guessing which method to intercept, this closes the gap by removing the
  // race entirely: the client calls this FIRST and awaits it, guaranteeing
  // the wallet already has real gas before the SDK does ANYTHING — no
  // dependency on which of its internal calls happens to go through this
  // proxy or in what order.
  if (method === 'mp_ensureGasFunded') {
    if (!userAddr) return { jsonrpc: '2.0', id, error: { code: -32600, message: 'missing ?user= param' } }
    // Same conservative flat buffer as the eth_call pre-fund below — covers
    // every gas cost this file's own GAS_BY_SELECTOR map anticipates (max
    // 1,500,000 gas, see that map's own doc comment) with real margin,
    // cheap enough to over-fund by a bit. Raised alongside the map's own
    // ceiling — this is a pre-flight buffer only; eth_sendRawTransaction
    // below funds the REAL signed gasLimit × gasPrice regardless of what
    // this constant says.
    const ENSURE_FUNDED_BUFFER_WEI = 4000000000000000n // 0.004 ETH-equivalent
    try {
      const { error, fundedWei } = await ensureFunded(rpcs, relayKey, userAddr, ENSURE_FUNDED_BUFFER_WEI, id)
      if (error) return error
      // fundedWei — real wei MeshPort's relay wallet actually transferred
      // to the user's wallet just now (0 if it already had enough). Only
      // meaningful field added here beyond the original {result:true} —
      // lets the client show a genuine "gas MeshPort covered" figure
      // instead of a guessed one. See MultichainClaimPage.tsx's
      // _gasFundedByChain / totalFeesLabel for where this is summed and
      // converted to USD.
      return { jsonrpc: '2.0', id, result: true, fundedWei: (fundedWei ?? 0n).toString() }
    } catch (e) {
      // sendSignedTx (called from inside ensureFunded) has several rpc()
      // calls with no try/catch of their own — if every configured RPC for
      // this chain is genuinely down, one of those throws, and without this
      // catch it propagates all the way up to a bare 500 with no JSON body
      // at all, instead of the clean JSON-RPC error this endpoint is
      // supposed to always return. The client already treats a failed
      // mp_ensureGasFunded as non-fatal and continues anyway (see
      // backgroundBridge.ts) — but that graceful handling only works if it
      // actually gets valid JSON back to parse.
      return {
        jsonrpc: '2.0', id,
        error: { code: -32603, message: e?.message ?? 'mp_ensureGasFunded failed', ...(e?.data !== undefined ? { data: e.data } : {}) },
      }
    }
  }

  // ── Hardcoded gas for all Circle CCTP calls ───────────────────────────────────
  if (method === 'eth_estimateGas') {
    const tx     = params[0] ?? {}
    const to     = (tx.to ?? '').toLowerCase()
    const sel    = (tx.data ?? '0x').slice(0, 10).toLowerCase()
    const gasHex = GAS_BY_SELECTOR[sel]
              ?? (CIRCLE_CONTRACTS.has(to) ? '0x16e360' : null) // 1,500,000 — same ceiling as GAS_BY_SELECTOR's own bridgeWithPreapprovalAndHook entry, see its doc comment
              ?? (USDC_CONTRACTS.has(to)   ? '0xfde8'  : null)
    if (gasHex) {
      console.log(`[relay-rpc] estimateGas ${sel} → hardcoded ${parseInt(gasHex, 16)}`)
      return { jsonrpc: '2.0', id, result: gasHex }
    }
    // Unknown — return safe default, never let estimateGas hit the node
    console.log(`[relay-rpc] estimateGas unknown ${sel} → default 150000`)
    return { jsonrpc: '2.0', id, result: '0x249f0' }
  }

  // ── eth_call: Circle's SDK runs a pre-flight simulation (a dry-run
  // eth_call) before ever building/broadcasting the real transaction. That
  // used to fall straight through to the real RPC untouched, with none of
  // the funding protection eth_sendRawTransaction already had below —
  // running against the wallet's actual current on-chain balance, which
  // for a freshly-imported/rarely-used testnet wallet is routinely near
  // zero. On a chain whose eth_call implementation validates the caller
  // can plausibly afford the call, that simulation genuinely reverts on
  // insufficient funds — reported by the SDK as "Simulation failed:
  // Transaction reverted", which reads exactly like a real contract-logic
  // failure even though it's actually just "this wallet has no gas yet."
  // The real funding never gets a chance to run because that only ever
  // triggered on the LATER eth_sendRawTransaction call, by which point the
  // SDK had already given up after the simulation failed. Pre-funding here
  // too — before forwarding, not after — closes that gap. Scoped to calls
  // targeting a known CCTP/USDC contract specifically, so this doesn't
  // start funding every arbitrary eth_call (e.g. read-only balance checks)
  // that has nothing to do with a transaction about to be signed.
  if (method === 'eth_call') {
    const tx = params[0] ?? {}
    const to = (tx.to ?? '').toLowerCase()
    const from = tx.from ?? userAddr
    if (from && (CIRCLE_CONTRACTS.has(to) || USDC_CONTRACTS.has(to))) {
      try {
        // Flat conservative buffer — no signed tx to decode a real cost
        // from here, unlike eth_sendRawTransaction below. 0.004 native
        // token covers every gas cost this file's own GAS_BY_SELECTOR map
        // anticipates (max 1,500,000 gas, see that map's own doc comment)
        // with real margin, on every chain in CHAIN_DEFS — cheap enough
        // that over-funding by a bit is a non-issue, especially on a chain
        // as low-fee as Monad.
        const SIMULATE_BUFFER_WEI = 4000000000000000n // 0.004 ETH-equivalent
        const { error } = await ensureFunded(rpcs, relayKey, from, SIMULATE_BUFFER_WEI, id)
        if (error) return error
      } catch (e) {
        // Best-effort — if funding itself throws, still let the eth_call
        // through rather than blocking on this pre-flight step; worst
        // case it fails the same way it did before this fix existed.
        console.warn('[relay-rpc] eth_call pre-fund failed (continuing anyway):', e?.message)
      }
    }
    // Fall through to the generic pass-through below regardless — this
    // block only ever funds first, never answers eth_call itself.
  }

  // ── eth_sendRawTransaction: check ETH balance, fund only if needed ────────────
  if (method === 'eth_sendRawTransaction') {
    const rawTx = params[0]
    if (!rawTx) return { jsonrpc: '2.0', id, error: { code: -32600, message: 'missing rawTx' } }
    if (!userAddr) return { jsonrpc: '2.0', id, error: { code: -32600, message: 'missing ?user= param' } }

    try {
      const rawTxHex = typeof rawTx === 'string'
        ? (rawTx.startsWith('0x') ? rawTx : '0x' + rawTx)
        : '0x' + Buffer.from(rawTx).toString('hex')

      const { ethers } = require('ethers')
      let requiredEth = 0n
      try {
        const decoded = ethers.Transaction.from(rawTxHex)
        const gasLimit = BigInt(decoded.gasLimit ?? 300000)
        // Use maxFeePerGas for EIP-1559, gasPrice for legacy — minimum 1 gwei floor
        const rawGasPrice = BigInt(decoded.maxFeePerGas ?? decoded.gasPrice ?? 1000000000n)
        const gasPrice = rawGasPrice < 1000000000n ? 1000000000n : rawGasPrice // min 1 gwei
        requiredEth = gasLimit * gasPrice
        console.log(`[relay-rpc] tx needs: gasLimit=${gasLimit} × gasPrice=${ethers.formatUnits(gasPrice,'gwei')}gwei = ${ethers.formatEther(requiredEth)} ETH`)
      } catch (e) {
        requiredEth = BigInt('500000000000000') // 0.0005 ETH fallback
        console.warn(`[relay-rpc] could not decode tx, using fallback ${requiredEth} wei`)
      }

      const { error, fundedWei } = await ensureFunded(rpcs, relayKey, userAddr, requiredEth, id)
      if (error) return error

      // Submit user's original signed tx
      console.log(`[relay-rpc] submitting user tx ${rawTxHex.slice(0, 20)}...`)
      const result = await rpc(rpcs, 'eth_sendRawTransaction', [rawTxHex], id)
      console.log(`[relay-rpc] ✓ user tx: ${result.result}`)
      // fundedWei tacked onto the normal JSON-RPC response — same reasoning
      // as mp_ensureGasFunded above, real wei MeshPort actually transferred
      // to cover THIS specific broadcast (0 if the wallet was already
      // funded from an earlier mp_ensureGasFunded call this session).
      return { ...result, fundedWei: (fundedWei ?? 0n).toString() }

    } catch (e) {
      const msg = e?.message ?? String(e)
      console.error('[relay-rpc] failed:', msg)
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: typeof e?.code === 'number' ? e.code : -32603,
          message: msg,
          ...(e?.data !== undefined ? { data: e.data } : {}),
        },
      }
    }
  }

  // ── relay_address ─────────────────────────────────────────────────────────────
  if (method === 'relay_address') {
    try {
      const { ethers } = require('ethers')
      return { jsonrpc: '2.0', id, result: new ethers.Wallet(relayKey).address }
    } catch { return { jsonrpc: '2.0', id, result: null } }
  }

  // ── Pass-through ──────────────────────────────────────────────────────────────
  try { return await rpc(rpcs, method, params, id) }
  catch (e) {
    // Bug fix, same reasoning as rpc()'s error handling above: this used
    // to only forward e.message, silently dropping e.data/e.code even
    // though rpc() now preserves them. This is the LAST step before the
    // error reaches Circle's SDK client-side — losing them here would
    // undo the fix above entirely. Standard JSON-RPC error shape
    // {code, message, data} is what ethers/the SDK actually knows how to
    // decode a specific revert reason from.
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: typeof e.code === 'number' ? e.code : -32603,
        message: e.message,
        ...(e.data !== undefined ? { data: e.data } : {}),
      },
    }
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || ''
  res.setHeader('Access-Control-Allow-Origin', origin.includes('localhost') ? origin : (process.env.ALLOWED_ORIGIN || '*'))
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const chainId  = req.query.chain
  const userAddr = req.query.user
  const chain    = CHAIN_DEFS[chainId]
  if (!chain) return res.status(400).json({ error: `Unknown chain: ${chainId}` })

  let relayKey = (process.env.RELAY_PRIVATE_KEY || '').trim()
  if (!relayKey) return res.status(500).json({ error: 'RELAY_PRIVATE_KEY not set' })
  if (!relayKey.startsWith('0x')) relayKey = '0x' + relayKey

  try {
    const body = req.body
    if (Array.isArray(body)) {
      const results = await Promise.all(body.map(i => handleOne(i, chain.rpcs, relayKey, userAddr)))
      return res.status(200).json(results)
    }
    return res.status(200).json(await handleOne(body, chain.rpcs, relayKey, userAddr))
  } catch (e) {
    console.error('[relay-rpc] unhandled:', e?.message)
    return res.status(500).json({ error: e?.message ?? 'Internal error' })
  }
}
