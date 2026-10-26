import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'

// The hero's live thing: type a name and an amount and read the payment
// MeshPort would make - the .arc username is what no other wallet has.
// Same cleaning rule as claiming a username (AuthPages).
const cleanName = (v: string) => v.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20)
const cleanAmount = (v: string) => {
  const s = v.replace(/[^0-9.]/g, '')
  const [whole, ...rest] = s.split('.')
  return rest.length ? `${whole.slice(0, 7)}.${rest.join('').slice(0, 2)}` : whole.slice(0, 7)
}
const AMOUNTS = ['5', '10', '25', '50']

export function PayByName() {
  const navigate = useNavigate()
  const [name, setName] = useState('john')
  const [amount, setAmount] = useState('10')
  const to = name ? `${name}.arc` : 'someone.arc'
  const value = Number(amount) || 0
  const shown = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <div data-ui className="w-full max-w-[460px] rounded-[24px] border border-border bg-surface p-5 sm:p-6">
      <label className="block">
        <span className="text-[14px] font-medium text-text-secondary">Send to</span>
        <span className="mt-2 flex items-center rounded-2xl border border-border bg-bg px-4 focus-within:border-brand">
          <input
            value={name}
            onChange={e => setName(cleanName(e.target.value))}
            placeholder="username"
            autoComplete="off"
            spellCheck={false}
            aria-label="Username to pay"
            className="min-w-0 flex-1 bg-transparent py-3.5 text-[20px] font-semibold text-text-primary outline-none placeholder:text-text-muted"
          />
          <span className="text-[20px] font-semibold text-text-muted">.arc</span>
        </span>
      </label>

      <label className="mt-4 block">
        <span className="text-[14px] font-medium text-text-secondary">Amount</span>
        <span className="mt-2 flex items-center rounded-2xl border border-border bg-bg px-4 focus-within:border-brand">
          <input
            value={amount}
            onChange={e => setAmount(cleanAmount(e.target.value))}
            inputMode="decimal"
            aria-label="Amount in USDC"
            className="min-w-0 flex-1 bg-transparent py-3.5 text-[20px] font-semibold tabular-nums text-text-primary outline-none"
          />
          <span className="text-[16px] font-semibold text-text-muted">USDC</span>
        </span>
      </label>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {AMOUNTS.map(a => (
          <button
            key={a}
            type="button"
            onClick={() => setAmount(a)}
            aria-pressed={amount === a}
            className={`rounded-xl py-2.5 text-[14px] font-semibold tabular-nums transition-colors ${amount === a ? 'bg-brand text-white' : 'bg-bg text-text-secondary hover:text-text-primary'}`}
          >
            {a}
          </button>
        ))}
      </div>

      <div className="mt-6 rounded-2xl bg-bg px-4 py-4">
        <p className="text-[14px] text-text-secondary"><span className="font-semibold text-text-primary">{to}</span> receives</p>
        <p className="mt-1 text-[34px] font-extrabold leading-none tracking-tight tabular-nums text-text-primary">
          {shown} <span className="text-[18px] font-bold text-text-secondary">USDC</span>
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">
          Gas is paid in USDC and the payment settles in under a second on Arc. No 42-character address to copy.
        </p>
      </div>

      <button
        type="button"
        onClick={() => navigate('/auth')}
        disabled={!name || value <= 0}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand px-5 py-4 text-[16px] font-bold text-white transition-transform active:scale-[0.98] disabled:opacity-50"
      >
        Send {value > 0 ? shown : ''} USDC to {to}
        <ArrowRight size={17} />
      </button>
      <p className="mt-3 text-center text-[13px] text-text-muted">You'll create your wallet first. It takes under a minute.</p>
    </div>
  )
}
