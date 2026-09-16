import { LandingNav } from './components/LandingNav'
import { Hero } from './components/Hero'
import { TrustedTech } from './components/TrustedTech'
import { PaymentStory } from './components/PaymentStory'
import { FeaturesGrid } from './components/FeaturesGrid'
import { MultichainStory } from './components/MultichainStory'
import { SelfCustody } from './components/SelfCustody'
import { HowItWorks } from './components/HowItWorks'
import { DashboardShowcase } from './components/DashboardShowcase'
import { FAQSection } from './components/FAQSection'
import { FinalCTA } from './components/FinalCTA'
import { Footer } from './components/Footer'

/**
 * Public marketing/landing page — standalone route (`/landing`), not gated
 * by AuthGuard and not inside AppLayout (no sidebar/bottom nav). Reuses the
 * app's own theme tokens (bg/surface/border/brand/text-* via CSS vars) so
 * light/dark mode, already resolved by index.html's pre-paint bootstrap
 * script, applies automatically — no separate theming system for this page.
 */
export function LandingPage() {
  return (
    <div className="min-h-dvh bg-bg text-text-primary" style={{ scrollBehavior: 'smooth' }}>
      <LandingNav />
      <main>
        <Hero />
        <TrustedTech />
        <PaymentStory />
        <FeaturesGrid />
        <MultichainStory />
        <SelfCustody />
        <HowItWorks />
        <DashboardShowcase />
        <FAQSection />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  )
}
