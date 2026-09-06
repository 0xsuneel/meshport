import { Reveal } from './Reveal'
import { DesktopDashboardMockup, MobileDashboardMockup } from './DashboardMockup'

export function DashboardShowcase() {
  return (
    <section className="overflow-hidden bg-surface/40 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="text-[12.5px] font-bold uppercase tracking-[0.08em] text-brand">See it in action</p>
          <h2 className="mt-3 text-[30px] font-extrabold tracking-tight text-text-primary sm:text-[38px]">
            One interface, every screen size
          </h2>
          <p className="mt-4 text-[15.5px] leading-relaxed text-text-secondary">
            The same premium experience on desktop and mobile — nothing feels like an afterthought.
          </p>
        </Reveal>

        <div className="mt-16 flex flex-col items-center gap-14 lg:flex-row lg:items-end lg:justify-center lg:gap-16">
          <div className="w-full max-w-[560px]">
            <DesktopDashboardMockup />
            <p className="mt-5 text-center text-[13px] font-semibold text-text-secondary">Desktop</p>
          </div>
          <div>
            <MobileDashboardMockup />
            <p className="mt-5 text-center text-[13px] font-semibold text-text-secondary">Mobile</p>
          </div>
        </div>
      </div>
    </section>
  )
}
