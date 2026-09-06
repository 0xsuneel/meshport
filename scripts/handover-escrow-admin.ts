/**
 * ONE-TIME SCRIPT — hands escrow contract admin rights over to your
 * everyday admin-panel wallet, so Pause / Resolve Dispute in the app
 * itself start working without ever importing the old key into a browser.
 *
 * Run locally (never on Vercel, never commit the keys anywhere):
 *
 *   OLD_ADMIN_PRIVATE_KEY=0x... \
 *   NEW_ADMIN_PRIVATE_KEY=0x... \
 *   npx tsx scripts/handover-escrow-admin.ts
 *
 * - OLD_ADMIN_PRIVATE_KEY = the key that IS the current contract admin
 *   (0xd9db937066e4e11d233993e44e838923ecdce950)
 * - NEW_ADMIN_PRIVATE_KEY = the key your admin panel session already
 *   uses (0x05d00ab75bcbe15450143f810cd5e5164ee126e0) — export it from
 *   Profile → (wallet/security section) in the app first.
 *
 * After this completes, delete your shell history / unset these env vars.
 * Never paste private keys into chat, tickets, or committed files.
 */
import { privateKeyToAccount } from 'viem/accounts'
import {
  transferAdmin, acceptAdmin, getEscrowAdminAddress, isEscrowContractDeployed,
} from '../src/lib/p2pEscrowContract'

async function main() {
  const oldKey = process.env.OLD_ADMIN_PRIVATE_KEY
  const newKey = process.env.NEW_ADMIN_PRIVATE_KEY
  if (!oldKey || !newKey) {
    throw new Error('Set OLD_ADMIN_PRIVATE_KEY and NEW_ADMIN_PRIVATE_KEY env vars before running.')
  }
  if (!isEscrowContractDeployed()) {
    throw new Error('VITE_P2P_ESCROW_CONTRACT is not set — run this with the same env the app uses.')
  }

  const oldAccount = privateKeyToAccount(oldKey as `0x${string}`)
  const newAccount = privateKeyToAccount(newKey as `0x${string}`)

  const currentAdmin = await getEscrowAdminAddress()
  console.log('Current on-chain admin:', currentAdmin)
  console.log('Old key address:       ', oldAccount.address.toLowerCase())
  console.log('New key address:       ', newAccount.address.toLowerCase())

  if (currentAdmin !== oldAccount.address.toLowerCase()) {
    throw new Error('OLD_ADMIN_PRIVATE_KEY does not match the contract\'s current admin. Aborting — nothing was sent.')
  }

  console.log('\nStep 1/2: transferAdmin() — signing with the OLD admin key...')
  const tx1 = await transferAdmin(oldKey, newAccount.address)
  console.log('  tx:', tx1, '— wait for it to confirm before continuing (check your chain explorer).')

  console.log('\nStep 2/2: acceptAdmin() — signing with the NEW admin key...')
  console.log('  (If this errors, the transferAdmin tx above probably hasn\'t confirmed yet — wait and re-run just this script; it\'s safe to re-run.)')
  const tx2 = await acceptAdmin(newKey)
  console.log('  tx:', tx2)

  console.log('\nDone. Re-check with getEscrowAdminAddress() after both txs confirm — it should now equal', newAccount.address.toLowerCase())
}

main().catch(e => { console.error('\nFailed:', e.message ?? e); process.exit(1) })
