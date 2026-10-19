# Recurring Billing — Design Spec

Status: **proposal** (not implemented). Author: Claude Code session.
Scope: subscriptions / standing orders for MeshPort merchants — charge a
customer a fixed USDC amount on a schedule (weekly, monthly, …) without the
customer re-approving each charge.

---

## 1. Why this is not "just code"

MeshPort wallets are **self-custodial EOAs** (`privateKeyToAccount` /
`generatePrivateKey`, viem). The private key lives only on the customer's
device. A plain EOA has no mechanism by which a third party (the merchant, or
a MeshPort backend) can move its funds. Every transfer must be signed, on the
device, by that key.

So "charge the customer every month automatically" is impossible with EOAs
**as they are today** — there is nothing to automate against. Recurring
billing requires the customer to grant, once, a *bounded standing
authorization* that a puller can later draw against on schedule. That
authorization has to live somewhere the customer's key signed into:

- an **on-chain allowance** to a puller contract, or
- an **on-chain mandate** (a subscription contract the customer opts into), or
- a **smart-account session key** with a spending limit.

All three need a smart contract deployed on Arc and an off-chain **keeper**
(scheduler) to trigger each charge. That is the part a single coding session
cannot produce safely — it is a contract + an audited money-moving backend,
not an app feature.

This document specifies the options and a recommended path so the work can be
scoped and built deliberately.

---

## 2. Primitives available on Arc / Circle

| Primitive | Works with today's EOAs? | Recurring-capable alone? | Notes |
|---|---|---|---|
| **EIP-3009** `transferWithAuthorization` | ✅ yes | ❌ no | Single-use: one nonce, one exact amount, one validity window. Great for *one* gasless pull, not a standing mandate. |
| **ERC-2612 `permit`** | ✅ yes | ❌ no | Single allowance grant by signature; still needs a puller contract to spend it. |
| **ERC-20 `approve`** → puller contract | ✅ yes | ✅ yes | Customer approves a MeshPort `SubscriptionHub` contract for a capped allowance; keeper calls `charge()` on schedule. Simplest recurring model for EOAs. |
| **Dedicated mandate contract** | ✅ yes | ✅ yes | Customer calls `subscribe(merchant, amount, period)`; contract enforces amount/period caps; keeper calls `collect()`. Most control, most code. |
| **ERC-4337 smart accounts + session keys** | ⚠️ needs account migration | ✅ yes | Strongest model (per-merchant session key, spend limits, revocable) but every wallet must become a smart account. |
| **EIP-7702** (EOA delegates to smart-account code) | ✅ yes (upgrade step) | ✅ yes | Lets existing EOAs opt into 4337-style session keys without changing address. Newer; more moving parts. |

**Gas:** on Arc, USDC is the native gas token, so a keeper-submitted charge
pays its own gas in USDC. No separate gas-station or paymaster is needed for
the puller to transact (this is the same conclusion as the gasless analysis).

---

## 3. Recommended path

### Phase 1 — `SubscriptionHub` allowance-pull contract (recommended first build)

The lowest-friction model that works with **today's EOAs, no wallet
migration**:

1. **Customer opts in once.** On the subscribe screen, the customer signs an
   ERC-20 `approve(SubscriptionHub, cap)` on Arc, where `cap` is a bounded
   allowance (e.g. `amount × expected_charges`, or a rolling cap the contract
   enforces per period). This is the only on-device signature required until
   they change or cancel.
2. **`SubscriptionHub` contract** stores each subscription:
   `{ customer, merchant, amount, period, nextChargeAt, active }` and exposes
   `charge(subscriptionId)` which:
   - reverts unless `block.timestamp >= nextChargeAt`,
   - reverts unless `active`,
   - pulls exactly `amount` USDC from `customer` to `merchant` via
     `transferFrom` (bounded by the allowance the customer approved),
   - advances `nextChargeAt += period`,
   - emits `Charged(subscriptionId, amount, period)`.
   The per-subscription `amount`/`period` caps mean even a compromised keeper
   cannot over-charge or charge early.
3. **Keeper** (Supabase edge function on a `pg_cron` schedule — the same
   pattern as the existing `merchant-pay` watcher) wakes each minute, finds
   subscriptions whose `nextChargeAt <= now`, and submits `charge()` from a
   funded relayer EOA. The charge is idempotent on-chain (the contract advances
   `nextChargeAt`), so a double-fire is a no-op revert.
4. **Confirmation** reuses the existing merchant pipeline: the `Charged` /
   USDC `Transfer` log is picked up exactly like any other incoming payment,
   recorded in `merchant_payments`, and screened by the compliance/blocklist
   path already in place.

Customer cancels by calling `cancel(subscriptionId)` (or `approve(hub, 0)` to
revoke the allowance entirely). Nothing custodial ever touches the key.

### Phase 2 (optional) — EIP-7702 session keys

Once Arc's 7702 support is stable, offer customers an upgrade to a session-key
model: a per-merchant key with a hard spend limit and expiry, revocable from
the wallet. Strictly better UX/security than a standing allowance, but depends
on 7702 maturity and adds a smart-account layer. Treat as a later iteration,
not a launch requirement.

---

## 4. Data model (Supabase)

New table `merchant_subscriptions` (mirrors `merchant_payment_intents` style):

```
id                uuid pk
merchant_wallet   text            -- lower-cased, like merchant_payments
customer_user_id  uuid null
customer_wallet   text            -- the approving EOA
amount            numeric(20,6)   -- USDC per charge
period_seconds    integer         -- 604800 weekly, 2592000 monthly, …
chain             text            -- 'Arc_Testnet' for v1 (allowance lives there)
onchain_id        text null       -- SubscriptionHub subscriptionId once created
status            text            -- 'pending_approval' | 'active' | 'paused' | 'cancelled'
next_charge_at    timestamptz
last_charge_at    timestamptz null
allowance_tx      text null       -- the approve() tx
created_at        timestamptz default now()
```

- RLS: customer reads their own rows; merchant reads subscriptions to their
  wallet; the keeper uses the service role.
- Each successful charge inserts a normal `merchant_payments` row linked back
  via a new nullable `subscription_id` column (so the merchant ledger,
  notifications and screening all work unchanged).
- A CHECK constraint on `status`; a partial index on
  `(status, next_charge_at)` for the keeper's due-query.

---

## 5. Keeper design (edge function)

- New function `subscription-charge`, `verify_jwt=false`, gated by
  `isCronOrLegacyServiceCaller` (same shared auth as the other cron jobs).
- `pg_cron` every minute (reuse the existing cron infra).
- Query due subscriptions (`status='active' AND next_charge_at <= now()`),
  cap the batch per run.
- For each: submit `charge(onchain_id)` from the relayer EOA (its key in a
  Supabase secret), with a per-subscription idempotency guard in the DB
  (`last_charge_at` advanced only after the tx confirms).
- On revert "allowance exhausted" / "insufficient balance": set
  `status='paused'`, notify both parties ("subscription needs attention"),
  and surface a re-approve CTA to the customer. Never retry-spam.
- Confirmation is **not** done here — the existing watcher records the
  resulting `Transfer`, keeping one source of truth for payments.

---

## 6. Security considerations

- **Bounded authorization.** The contract enforces `amount` and `period` per
  subscription, so the trust placed in the keeper is capped — it can never
  pull more than one period's `amount`, nor earlier than `nextChargeAt`.
- **Relayer key** is a hot key in Supabase secrets; it only pays gas and calls
  `charge()`, it holds no customer funds. Rotate it like the other secrets.
- **Allowance hygiene.** Prefer a per-period cap enforced in-contract over a
  large blanket `approve`. If a blanket allowance is used, show the customer
  exactly what they're approving and offer one-tap revoke.
- **Screening.** Each charge flows through the compliance/blocklist screening
  already built, so a customer or merchant later flagged is caught.
- **Cancellation must be customer-sovereign:** `cancel()` and allowance
  revocation are on-chain actions the customer signs — MeshPort cannot block a
  cancellation.

---

## 7. Effort estimate (rough)

| Piece | Effort | Notes |
|---|---|---|
| `SubscriptionHub` Solidity contract + tests + Arc testnet deploy | 2–4 days | needs review; money-moving |
| `merchant_subscriptions` schema + RLS + `subscription_id` on payments | 0.5 day | |
| Subscribe/manage UI (approve, list, cancel) | 1–2 days | |
| `subscription-charge` keeper edge function + cron | 1 day | |
| Confirmation wiring (reuse watcher) + merchant ledger display | 0.5 day | |
| End-to-end testnet validation | 1 day | |

The contract is the critical-path, highest-risk item and should be reviewed
(ideally audited) before touching real value. Everything else reuses patterns
MeshPort already has.

---

## 8. Open questions for the product owner

1. Billing periods to support at launch (weekly / monthly / custom)?
2. Per-period in-contract cap, or a blanket allowance with off-chain
   scheduling? (Recommend per-period cap.)
3. Arc-only for v1, or allow subscriptions funded on other chains? (Recommend
   Arc-only first — the allowance and keeper live on one chain.)
4. Who funds the relayer's gas — platform, or netted from merchant receipts?
5. Dunning policy on a failed charge: pause immediately, or retry window?
```
