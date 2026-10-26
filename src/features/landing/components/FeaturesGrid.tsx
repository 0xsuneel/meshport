import { Reveal } from './Reveal'

// Every feature as an index in three columns - what you can do, grouped by
// the job it does - instead of nine identical icon cards.
const GROUPS = [
  {
    label: 'Pay',
    items: [
      { title: 'Username Payments', desc: 'Send USDC using a .arc username instead of copying a long wallet address.' },
      { title: 'Receive & QR', desc: 'Create a payment request and let another user pay directly into your wallet.' },
      { title: 'Chat Payments', desc: 'Send payments directly inside conversations.' },
      { title: 'Bulk Payments', desc: 'Send USDC to multiple recipients in one flow - payroll, contributors, or group payouts.' },
    ],
  },
  {
    label: 'Move',
    items: [
      { title: 'Multichain Claim', desc: 'Claim supported crosschain USDC into your Arc wallet.' },
      { title: 'Multichain Transfer', desc: 'Move supported assets across supported networks.' },
    ],
  },
  {
    label: 'Manage',
    items: [
      { title: 'Swap on Arc', desc: 'Exchange supported assets directly on Arc with a quoted rate before you confirm.' },
      { title: 'P2P', desc: 'Buy and sell USDC directly with other users, protected by an escrow-based flow.' },
      { title: 'Activity', desc: 'Track every payment and transaction in one place.' },
    ],
  },
]

export function FeaturesGrid() {
  return (
    <section id="features" className="scroll-mt-24 mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
      <Reveal className="max-w-2xl">
        <h2 className="text-[30px] font-extrabold tracking-tight text-text-primary sm:text-[40px]">
          Built for how people actually pay
        </h2>
        <p className="mt-4 text-[18px] leading-relaxed text-text-primary">
          A payment app first, with the tools to move, swap, and trade USDC when you need them.
        </p>
      </Reveal>

      <div className="mt-14 grid grid-cols-1 gap-12 md:grid-cols-3 md:gap-10">
        {GROUPS.map(group => (
          <Reveal key={group.label}>
            <h3 className="text-[24px] font-extrabold text-text-primary">{group.label}</h3>
            <ul className="mt-6 flex flex-col gap-6">
              {group.items.map(f => (
                <li key={f.title}>
                  <p className="text-[18px] font-bold text-text-primary">{f.title}</p>
                  <p className="mt-1 text-[16px] leading-relaxed text-text-secondary">{f.desc}</p>
                </li>
              ))}
            </ul>
          </Reveal>
        ))}
      </div>
    </section>
  )
}
