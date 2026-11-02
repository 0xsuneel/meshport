// Open any page with ?vpdebug to see the phone's real viewport numbers (for
// fixing the strip under the bottom nav). Nothing shows without it.

export function installViewportDebug(): void {
  if (typeof window === 'undefined' || !/[?&]vpdebug\b/.test(window.location.search)) return
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:0;visibility:hidden;pointer-events:none;' +
    'padding-bottom:env(safe-area-inset-bottom,0px);padding-top:env(safe-area-max-inset-bottom,0px);'
  const box = document.createElement('pre')
  box.style.cssText = 'position:fixed;left:8px;right:8px;top:40%;z-index:2147483647;margin:0;padding:10px;' +
    'background:rgba(0,0,0,.85);color:#7CFFB2;font:12px/1.5 monospace;border-radius:10px;white-space:pre-wrap;pointer-events:none'
  document.body.append(probe, box)
  const show = () => {
    const vv = window.visualViewport
    const cs = getComputedStyle(probe)
    const shell = document.querySelector('[data-page-shell]')?.getBoundingClientRect()
    const nav = document.querySelector('[data-bottom-nav]')?.getBoundingClientRect()
    box.textContent = [
      `screen ${screen.width}x${screen.height} dpr ${devicePixelRatio}`,
      `innerHeight ${innerHeight}  clientHeight ${document.documentElement.clientHeight}`,
      `visualViewport ${vv ? `${Math.round(vv.height)} (top ${Math.round(vv.offsetTop)})` : 'none'}`,
      `safe-area-inset-bottom ${cs.paddingBottom}  max ${cs.paddingTop}`,
      `standalone ${matchMedia('(display-mode: standalone)').matches}`,
      `shell bottom ${shell ? Math.round(shell.bottom) : '-'}  nav bottom ${nav ? Math.round(nav.bottom) : '-'}`,
    ].join('\n')
  }
  show()
  window.visualViewport?.addEventListener('resize', show)
  window.addEventListener('resize', show)
  setInterval(show, 1000)
}
