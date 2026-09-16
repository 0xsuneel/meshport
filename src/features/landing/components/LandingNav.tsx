import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Menu, X, Sun, Moon } from 'lucide-react'
import { useThemeStore, resolveTheme } from '@/store/themeStore'

const LINKS = [
  { label: 'Features', href: '#features' },
  { label: 'Self-Custody', href: '#self-custody' },
  { label: 'How It Works', href: '#how-it-works' },
  { label: 'FAQ', href: '#faq' },
]

export function LandingNav() {
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const mode = useThemeStore(s => s.mode)
  const setMode = useThemeStore(s => s.setMode)
  const isDark = resolveTheme(mode) === 'dark'

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Native <a href="#section"> jumps are unreliable here on mobile: the
  // click fires while the mobile menu is still mid-collapse (its height
  // animation is still running), so the browser computes the scroll offset
  // against a header that's about to shrink and the jump lands in the
  // wrong place (or appears not to happen at all). Taking scrolling over
  // manually and waiting for the collapse animation to finish first makes
  // it deterministic on both mobile and desktop. history.pushState keeps
  // the URL's hash in sync so the links stay shareable/bookmarkable.
  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault()
    const wasMenuOpen = menuOpen
    setMenuOpen(false)

    const jump = () => {
      const el = document.querySelector(href)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        window.history.pushState(null, '', href)
      }
    }

    if (wasMenuOpen) {
      window.setTimeout(jump, 260)
    } else {
      jump()
    }
  }

  return (
    <header
      style={{
        position: 'sticky', top: 0, zIndex: 50,
        background: scrolled ? 'color-mix(in srgb, var(--bg) 82%, transparent)' : 'transparent',
        backdropFilter: scrolled ? 'blur(16px)' : 'none',
        borderBottom: scrolled ? '1px solid var(--border)' : '1px solid transparent',
        transition: 'background-color 200ms ease, border-color 200ms ease',
      }}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5" aria-label="MeshPort home">
          <img src="/favicon.svg" alt="MeshPort" className="h-8 w-8 rounded-lg" style={{ boxShadow: 'var(--shadow-1)' }} />
          <span className="text-[17px] font-extrabold tracking-tight text-text-primary">MeshPort</span>
        </a>

        <nav className="hidden items-center gap-8 lg:flex" aria-label="Primary">
          {LINKS.map(link => (
            <a
              key={link.href}
              href={link.href}
              onClick={e => handleNavClick(e, link.href)}
              className="text-[14px] font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={() => setMode(isDark ? 'light' : 'dark')}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-border bg-surface text-text-secondary transition-colors hover:text-text-primary sm:h-11 sm:w-11"
          >
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
          </button>

          {/* Text shrinks and drops its padding first on the smallest
              viewports so it never wraps to two lines and blows up the
              header's height alongside the two 44px circular buttons and
              the wordmark — see the mobile screenshot this fixes. */}
          <button
            onClick={() => navigate('/auth')}
            className="whitespace-nowrap rounded-xl bg-brand px-3 py-2 text-[12.5px] font-bold text-white shadow-elevation-1 transition-transform active:scale-[0.97] sm:px-5 sm:py-2.5 sm:text-[13.5px]"
          >
            Launch MeshPort
          </button>

          <button
            onClick={() => setMenuOpen(v => !v)}
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-border bg-surface text-text-primary lg:hidden sm:h-11 sm:w-11"
          >
            {menuOpen ? <X size={17} /> : <Menu size={17} />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {menuOpen && (
          <motion.nav
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            aria-label="Mobile"
            className="overflow-hidden border-t border-border bg-bg lg:hidden"
          >
            <div className="flex flex-col gap-1 px-5 py-4">
              {LINKS.map(link => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={e => handleNavClick(e, link.href)}
                  className="rounded-xl px-3 py-3 text-[15px] font-medium text-text-primary transition-colors hover:bg-surface"
                >
                  {link.label}
                </a>
              ))}
            </div>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  )
}
