const PRODUCT = [
  { label: 'Features', href: '#features' },
  { label: 'How It Works', href: '#how-it-works' },
  { label: 'FAQ', href: '#faq' },
]
const LEGAL = [
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms', href: '/terms' },
]
const SOCIAL = [
  { label: 'GitHub', href: 'https://github.com/0xsuneel/meshport' },
  { label: 'X', href: 'https://x.com/meshport_xyz' },
]

function FooterCol({ title, links }: { title: string; links: { label: string; href: string; external?: boolean }[] }) {
  return (
    <div>
      <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-text-muted">{title}</p>
      <ul className="mt-4 flex flex-col gap-3">
        {links.map(l => (
          <li key={l.label}>
            <a
              href={l.href}
              target={l.external ? '_blank' : undefined}
              rel={l.external ? 'noopener noreferrer' : undefined}
              className="text-[14px] font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-16">
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <a href="#top" className="flex items-center gap-2.5" aria-label="MeshPort home">
              <img src="/favicon.svg" alt="MeshPort" className="h-8 w-8 rounded-lg" />
              <span className="text-[16px] font-extrabold tracking-tight text-text-primary">MeshPort</span>
            </a>
            <p className="mt-3 max-w-[220px] text-[13px] leading-relaxed text-text-secondary">
              USDC Payments, Made Simple.
            </p>
          </div>
          <FooterCol title="Product" links={PRODUCT} />
          <FooterCol title="Legal" links={LEGAL} />
          <FooterCol title="Community" links={SOCIAL.map(s => ({ ...s, external: true }))} />
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-border pt-8 sm:flex-row">
          <p className="text-[12.5px] text-text-muted">&copy; {new Date().getFullYear()} MeshPort. All rights reserved.</p>
          <p className="text-[12.5px] text-text-muted">Built on Arc &middot; Arc Testnet</p>
        </div>
      </div>
    </footer>
  )
}
