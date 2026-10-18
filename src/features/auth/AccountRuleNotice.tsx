// The message shown when a sign-in doesn't match the account it reached
// (see src/lib/accountRules.ts): wrong account type, no MeshPort account
// yet, or an account that already exists on the Create account path.
import { motion } from 'framer-motion'
import { Store, User as UserIcon, UserPlus, Loader2 } from 'lucide-react'
import type { AccessDecision } from '@/lib/accountRules'
import type { AccountKind } from '@/lib/onchainNames'

type Blocked = Exclude<AccessDecision, { kind: 'allow' }>

const typeName = (k: AccountKind) => (k === 'business' ? 'business' : 'personal')
const TypeName = (k: AccountKind) => (k === 'business' ? 'Business' : 'Personal')

/** Copy for each blocked case - exported for tests and screenshots. */
export function accountRuleCopy(d: Blocked, via: 'wallet' | 'login') {
  switch (d.kind) {
    case 'mismatch':
      return {
        title: `This is a ${typeName(d.existing)} account`,
        text: `You already have a ${typeName(d.existing)} account with this ${via}. An account’s type can’t be changed, so it opens as ${TypeName(d.existing)}.`,
        action: `Continue as ${TypeName(d.existing)}`,
      }
    case 'already_exists':
      return {
        title: `You already have a ${typeName(d.existing)} account`,
        text: `This ${via} already has a MeshPort ${typeName(d.existing)} account, so a new account can’t be created with it. Log in instead.`,
        action: `Log in as ${TypeName(d.existing)}`,
      }
    case 'no_account':
      return {
        title: 'No MeshPort account found',
        text: `No MeshPort account found for this ${via}. Create an account first, then you can log in with it.`,
        action: 'Create an account',
      }
  }
}

export function AccountRuleNotice({ decision, via, busy, onContinue, onBack, backLabel }: {
  decision: Blocked
  via: 'wallet' | 'login'
  busy?: boolean
  onContinue: () => void
  onBack: () => void
  backLabel?: string
}) {
  const copy = accountRuleCopy(decision, via)
  const icon = decision.kind === 'no_account'
    ? <UserPlus className="w-7 h-7" />
    : decision.existing === 'business' ? <Store className="w-7 h-7" /> : <UserIcon className="w-7 h-7" />
  return (
    <div className="flex flex-col h-full bg-bg items-center justify-center px-6">
      <motion.div role="alert" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center space-y-4 max-w-sm w-full">
        <div className={`w-16 h-16 rounded-full flex items-center justify-center mx-auto ${decision.kind === 'no_account' ? 'bg-warning/15 text-warning' : 'bg-brand/15 text-brand-text'}`}>
          {icon}
        </div>
        <div>
          <h2 className="text-[20px] tracking-[-0.2px] font-bold text-text-primary">{copy.title}</h2>
          <p className="text-text-secondary text-[14px] leading-[1.5] mt-2">{copy.text}</p>
        </div>
        <div className="space-y-2 pt-2">
          <button type="button" onClick={onContinue} disabled={busy}
            className="w-full py-3.5 rounded-2xl bg-brand text-white font-bold shadow-elevation-2 active:scale-[0.98] transition-transform border border-black/10 flex items-center justify-center gap-2 disabled:opacity-60">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}{copy.action}
          </button>
          <button type="button" onClick={onBack} disabled={busy}
            className="w-full py-3 text-sm font-semibold text-text-secondary">
            {backLabel ?? (via === 'wallet' ? 'Use a different wallet' : 'Use a different login')}
          </button>
        </div>
      </motion.div>
    </div>
  )
}
