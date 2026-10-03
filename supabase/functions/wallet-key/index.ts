// supabase/functions/wallet-key/index.ts
//
// RETIRED (2026-10-04). Google / email wallets are self-custodial: made on
// the device and unlocked with the account's passkey or encrypted Recovery
// QR (src/lib/socialWallet.ts, walletPasskey.ts, recoveryQr.ts). MeshPort's
// servers no longer hold, create or return any wallet key, so this function
// only answers 410 Gone for anything still calling it (an old cached app).
// It reads no secrets; WALLET_MASTER_KEK_V* can be deleted.

Deno.serve((req: Request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  return new Response(JSON.stringify({ error: 'MeshPort no longer stores wallets on its servers. Update the app.', code: 'retired' }), { status: 410, headers })
})
