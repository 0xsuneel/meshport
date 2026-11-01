// Step timings inside a move: when each signature was asked for and when it
// came back (move_timings). Circle's kit signs inside deposit() - the
// permit, then the deposit transaction - so the 9 s deposit can be split
// into "waiting for the wallet" vs "waiting for the network". Signs exactly
// what it's given; only the timing is added.
import type { WalletAccount } from '@/wallet'

export function withSignMarks(account: WalletAccount, mark: (step: string) => void): WalletAccount {
  let typed = 0, tx = 0
  const wrapped: any = {
    ...account,
    async signTypedData(args: any) {
      const n = ++typed
      mark(`sign_typed${n}_ask`)
      const out = await account.signTypedData(args)
      mark(`sign_typed${n}`)
      return out
    },
    async signTransaction(args: any, opts?: any) {
      const n = ++tx
      mark(`sign_tx${n}_ask`)
      const out = await (account.signTransaction as any)(args, opts)
      mark(`sign_tx${n}`)
      return out
    },
  }
  return wrapped as WalletAccount
}
