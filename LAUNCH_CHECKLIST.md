# MeshPort Launch Checklist

_Generated: June 2026 | Testnet_

---

## ✅ Completed

| Feature | Status | Notes |
|---------|--------|-------|
| Username registration | ✅ Done | `.arc` suffix, Supabase, onboarding nav fixed |
| Arc payments (send) | ✅ Done | USDC, passcode, Arc username, balance refresh |
| Multichain receive | ✅ Done | QR code, wallet address display |
| Multichain claim — UI | ✅ Done | All 11 chains shown, per-chain progress |
| Multichain claim — bridge | ✅ Done | CCTP deposit + auto-credit via HomePage poller |
| Swap (USDC↔EURC↔cirBTC) | ✅ Done | DEX-style, balances, history, price impact |
| Contacts / Chat list | ✅ Done | Search, real-time unread badge |
| Chat messaging | ✅ Done | Text, image, file, realtime |
| Chat payments | ✅ Done | `.arc` exact match only, passcode required |
| Payment history in chat | ✅ Done | Inline in conversation, explorer link |
| Activity history | ✅ Done | ArcScan fetch, 30s refresh, visibility refresh |
| Transaction detail | ✅ Done | Explorer button always visible (overflow fixed) |
| Notifications | ✅ Done | Push via Supabase realtime |
| Rewards page | ✅ Done | Points display |
| Treasury page | ✅ Done | Balance overview |
| Explorer links | ✅ Done | arcscan.app on all tx detail + chat payments |
| Mobile responsive | ✅ Done | Sticky header/input, safe-area padding |
| Balance refresh — send | ✅ Done | Immediate after send tx |
| Balance refresh — swap | ✅ Done | USDC + EURC + cirBTC after swap |
| Balance refresh — claim | ✅ Done | Via HomePage auto-credit poller |
| Design system | ✅ Done | #050816/#0D1330, purple brand, consistent |
| cirBTC contract | ✅ Done | 0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF |
| USYC removed | ✅ Done | Only USDC/EURC/cirBTC in assets |
| Onboarding nav fix | ✅ Done | replace:true + route guard, no back to username setup |

---

## 🔄 In Progress

| Feature | Status | Blocking |
|---------|--------|---------|
| Multichain claim — Ethereum gas | 🔄 Relay-dependent | Relay wallet needs ETH funded on each chain |
| cirBTC balance display | 🔄 Working | Decimals confirmed (8), contract confirmed |
| Swap quote accuracy | 🔄 Working | Dependent on `/api/swap-proxy` quote endpoint |

---

## 🚫 Blocking Issues

| Issue | Impact | Fix |
|-------|--------|-----|
| Relay wallet ETH balance | Ethereum claims fail silently | Fund relay wallet on Ethereum Sepolia, Base Sepolia, etc. |
| CCTP 2–15 min delay | User thinks claim failed | Auto-credit poller handles it — UX shows "bridge submitted" |
| cirBTC swap liquidity | Swap may return 0 output | Arc testnet liquidity — not fixable from frontend |

---

## 🔧 Required Backend Work

| Item | Why |
|------|-----|
| Fund relay wallet on all 11 chains | Gas relay for multichain deposits |
| Verify `RELAY_PRIVATE_KEY` in Vercel env | Must be set for relay to work |
| Monitor `/api/relay-gas` logs | Watch for underfunded errors |

---

## 📄 Required Supabase Work

| Item | Status |
|------|--------|
| `multichain_tx` table | ✅ Exists |
| `messages` table with payment fields | ✅ Exists |
| `users` table with `username`, `wallet_address` | ✅ Exists |
| RLS policies for message/payment insert | ✅ Applied (supabase-rls-fix.sql) |
| Activity — no Supabase dependency | ✅ ArcScan direct fetch |

---

## ⛓️ Required Smart Contract Work

| Item | Status |
|------|--------|
| USDC on Arc (native) | ✅ `0x36000...` |
| EURC on Arc | ✅ `0x89B508...` |
| cirBTC on Arc | ✅ `0xf0C4a4...` |
| MeshPortRewards.sol | 🔄 Deployed separately — verify address in `.env` |
| CCTP contracts | ✅ Handled by Circle SDK |

---

## 📱 Mobile UX Status

| Item | Status |
|------|--------|
| Sticky top header | ✅ All pages |
| Sticky chat input bar | ✅ flex-shrink-0 + safe-area |
| Content-only scrolling | ✅ overflow-hidden parent + overflow-y-auto content |
| Safe area insets | ✅ pb-safe, pt-header, env() |
| Reduced header spacing | ✅ pt-header = safe-area + 8px |
| Back nav after registration | ✅ Fixed (replace:true) |

---

## 🚀 Pre-Launch Checklist

- [ ] Fund relay wallet with ETH on: Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia, Optimism Sepolia, Polygon Amoy, Avalanche Fuji, HyperEVM, Sei, Sonic, Unichain, World Chain
- [ ] Verify `RELAY_PRIVATE_KEY` is set in Vercel
- [ ] Verify `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set
- [ ] Verify `RELAY_MAX_AMOUNT_USDC` cap is set appropriately
- [ ] Test end-to-end: register → send → claim → swap → chat payment
- [ ] Verify ArcScan explorer links open correctly
- [ ] Test on iOS Safari and Android Chrome
