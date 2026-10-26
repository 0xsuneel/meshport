import { Reveal } from './Reveal'
import { DesktopDashboardMockup, MobileDashboardMockup } from './DashboardMockup'

export function DashboardShowcase() {
  return (
    <section className="overflow-hidden bg-surface/40 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="text-[30px] font-extrabold tracking-tight text-text-primary sm:text-[40px]">
            The same wallet on your phone and your desk
          </h2>
          <p className="mt-4 text-[18px] leading-relaxed text-text-primary">
            Your balance, assets and recent payments, laid out for each screen. Install it from your browser like an app.
          </p>
        </Reveal>

        <div className="mt-16 flex flex-col items-center gap-14 lg:flex-row lg:items-end lg:justify-center lg:gap-16">
          <div className="w-full max-w-[560px]">
            <DesktopDashboardMockup />
            <p className="mt-5 text-center text-[16px] font-semibold text-text-secondary">Desktop</p>
          </div>
          <div>
            <MobileDashboardMockup />
            <p className="mt-5 text-center text-[16px] font-semibold text-text-secondary">Mobile</p>
          </div>
        </div>
      </div>
    </section>
  )
}
