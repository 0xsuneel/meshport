# Contributing to MeshPort

Thanks for your interest in MeshPort. This is a testnet financial application — small mistakes in transaction, ledger, or custody code have real (if testnet-scoped) consequences, so a bit more rigor is expected here than in a typical UI-only project.

## Before you start

1. Read the [README](./README.md), especially [Architecture](./README.md#architecture), [Transaction Lifecycle](./README.md#transaction-lifecycle), and the [Developer Guide](./README.md#developer-guide--where-to-start).
2. For anything touching transactions, the ledger, multichain, or custody, also read [`ARCHITECTURE.md`](./ARCHITECTURE.md) and the relevant deep-dive documents under [`docs/`](./docs/) — several past bugs and their fixes are documented there in detail, and repeating them is avoidable.
3. Check `LAUNCH_CHECKLIST.md` and `CHANGES.md` for recent context on what's actively in flux.

## Setup

Follow [Local Development](./README.md#local-development) in the README. In short:

```bash
npm install
npm run typecheck
npm run lint
npm run test
npm run dev
```

## Scope discipline

This codebase has an explicit convention (see the project's own `meshport-transaction-architecture` guidance for transaction work): **make the smallest safe change required for the task.**

- Don't refactor unrelated code while fixing something else.
- Don't rewrite working CCTP/Unified Balance/ledger/indexer logic unless the task specifically calls for it.
- Don't introduce a new abstraction, provider, or duplicate service when an existing one already does the job — reuse first.
- If a change legitimately needs to touch more than a handful of files, or would replace an existing indexer/ledger/security boundary, say so explicitly and explain why before doing it, rather than silently expanding scope.

## Making changes

1. **Branch** from `main` (or your default branch) with a descriptive name.
2. **Check `git status`/`git diff` before and after** your change — never discard or overwrite unrelated in-progress work.
3. **Follow existing patterns** in the file/feature you're touching before introducing a new one. This repository consistently documents *why* a decision was made in comments directly above the relevant code — read those before changing the code near them.
4. **Financial correctness rules that must not be silently regressed:**
   - Never treat a JavaScript floating-point number as the source of truth for an amount — use atomic units + decimals, and format only at the UI boundary.
   - Never let a receipt-wait timeout become an automatic `FAILED` state — that's `SUBMITTED_UNKNOWN`, reconciled before any retry.
   - Never let a sender's client create the receiver's confirmed Activity row — receive is indexer-driven, not sender-driven.
   - Every user-triggered financial operation needs an idempotency key (see `pay-intent`/`swap-intent`/`bulkpay-intent` for the existing pattern).
   - Never send a private key, seed phrase, or mnemonic to any server, API, Edge Function, database, or log. Signing happens client-side except through the explicitly-designed server-custodial `wallet-key` envelope-encryption flow for social-login accounts.
5. **Database changes:** check existing migrations and tables under `supabase/migrations/` before adding a new table or column — prefer extending an existing canonical structure over creating a duplicate. Add a new, timestamped migration file; don't edit a migration that's already been applied elsewhere.
6. **Edge Functions:** several functions are deliberately self-contained (no shared imports) because of a Supabase dashboard deployment limitation — see the comment at the top of `supabase/functions/claim-worker/index.ts`. If your change touches logic that's duplicated across functions for this reason, update every copy.

## Testing

```bash
npm run typecheck          # frontend
npm run typecheck:server   # server/
npm run lint
npm run test                # Vitest — run the whole suite before opening a PR
```

For contract changes:
```bash
npm run contract:compile
npx hardhat test
```

Run the smallest relevant test file(s) while iterating; run the full suite before submitting. Add or update a test alongside any behavioral change in `src/lib`, `server/`, or `contracts/` — this repository's existing test files (`*.test.ts`) are a good model for style and the kind of edge cases worth covering (see `ActivityService.bulkReceivedGuard.test.ts` or `p2pService.stuckRelease.test.ts` for examples of tests written specifically to pin down a previously-found bug).

## Pull requests

Include:
- What changed and why, in plain terms.
- Which files changed (a short list is fine — the diff itself is authoritative).
- Whether a database migration is included, and whether it's been tested against a real Supabase project.
- Test commands run and their results.
- Any known remaining issue or follow-up, stated explicitly rather than left implicit.

Keep PRs focused on one feature or fix. A PR that touches Send, Swap, and P2P at once is much harder to review safely than three small PRs.

## Reporting issues

Open an issue describing:
- What you expected vs. what happened.
- Steps to reproduce (chain, wallet type — social login vs. self-custodial — and asset involved, since MeshPort's behavior genuinely differs by both).
- Whether it's testnet-infrastructure-related (e.g. attestation delay, relay wallet gas) or an application bug — see [Troubleshooting](./README.md#troubleshooting) first, since some "bugs" are expected testnet behavior.

## Security issues

This repository has no external bug bounty program on record. If you find a security issue — especially anything touching private key handling, the `wallet-key` envelope-encryption flow, or the P2P escrow contract — report it privately to the maintainers rather than opening a public issue, and give them a chance to respond before any public disclosure.

## License

This project is licensed under the MIT License (see [`LICENSE`](./LICENSE)). By contributing, you agree that your contributions will be licensed under the same terms.
