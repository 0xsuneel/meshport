import { useEffect, useRef } from 'react'

/**
 * Subtle animated network-node background for the hero — a lightweight
 * 2D canvas (no WebGL/Three.js needed for ~40 dots), not the
 * glow/bloom/pulsing-particle treatment common on crypto sites. Nodes drift
 * slowly and connect only within a proximity radius, at low opacity, in a
 * single muted brand tone — reads as "network," not "fireworks." Respects
 * prefers-reduced-motion by rendering one static frame instead of animating.
 */
export function NetworkBackground({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    let width = 0, height = 0
    let nodes: { x: number; y: number; vx: number; vy: number }[] = []
    let rafId: number

    const brandLine = 'rgba(18, 102, 95, 0.16)'   // --brand at low alpha
    const brandDot  = 'rgba(18, 102, 95, 0.35)'

    const setup = () => {
      const rect = canvas.parentElement?.getBoundingClientRect()
      width = rect?.width ?? window.innerWidth
      height = rect?.height ?? 480
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.scale(dpr, dpr)

      const count = Math.min(46, Math.round((width * height) / 22000))
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
      }))
    }

    const CONNECT_DIST = 130

    const drawFrame = () => {
      ctx.clearRect(0, 0, width, height)

      for (const n of nodes) {
        if (!reduceMotion) {
          n.x += n.vx
          n.y += n.vy
          if (n.x < 0 || n.x > width) n.vx *= -1
          if (n.y < 0 || n.y > height) n.vy *= -1
        }
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j]
          const dx = a.x - b.x, dy = a.y - b.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < CONNECT_DIST) {
            ctx.strokeStyle = brandLine
            ctx.globalAlpha = 1 - dist / CONNECT_DIST
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }
      ctx.globalAlpha = 1

      for (const n of nodes) {
        ctx.fillStyle = brandDot
        ctx.beginPath()
        ctx.arc(n.x, n.y, 1.6, 0, Math.PI * 2)
        ctx.fill()
      }

      if (!reduceMotion) rafId = requestAnimationFrame(drawFrame)
    }

    setup()
    drawFrame()

    const onResize = () => { setup() }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    />
  )
}
