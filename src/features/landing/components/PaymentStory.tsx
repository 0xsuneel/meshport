import { Reveal } from './Reveal'

const POINTS = [
  { label: 'Receive by QR', desc: 'Share a QR or payment link and get paid directly into your wallet.' },
  { label: 'Chat payments', desc: 'Send USDC without leaving a conversation.' },
  { label: 'Payment activity', desc: 'Every payment you send or receive, tracked in one place.' },
]

// Real app screens (the Feature Guide's captures), not drawings of them.
const SCREENS = [
  { image: 'pay', alt: 'The Pay screen: search a username and pay a recent contact' },
  { image: 'convo', alt: 'A chat with a payment sent inside the conversation' },
]

export function PaymentStory() {
  return (
    <section className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28">
      <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-16">
        <Reveal>
          <h2 className="text-[30px] font-extrabold leading-tight tracking-tight text-text-primary sm:text-[40px]">
            Payments without the wallet gymnastics.
          </h2>
          <p className="mt-5 max-w-[500px] text-[18px] leading-relaxed text-text-primary">
            No long addresses to copy. Send USDC to a MeshPort username and manage the payment directly inside MeshPort.
          </p>

          <dl className="mt-10 flex flex-col gap-6">
            {POINTS.map(p => (
              <div key={p.label}>
                <dt className="text-[18px] font-bold text-text-primary">{p.label}</dt>
                <dd className="mt-1 text-[16px] leading-relaxed text-text-secondary">{p.desc}</dd>
              </div>
            ))}
          </dl>
        </Reveal>

        <Reveal delay={0.1} className="grid grid-cols-2 gap-4 sm:gap-6">
          {SCREENS.map((s, i) => (
            <img
              key={s.image}
              data-ui
              src={`/guide/${s.image}.jpg`}
              alt={s.alt}
              width={390}
              height={780}
              loading="lazy"
              decoding="async"
              className={`block w-full rounded-[24px] border border-border ${i === 1 ? 'mt-12' : ''}`}
            />
          ))}
        </Reveal>
      </div>
    </section>
  )
}
