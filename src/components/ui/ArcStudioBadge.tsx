// ArcStudioBadge.tsx
// "Built with Arc Studio" badge - links out to Arc Studio in a new tab.
// Shared by the desktop sidebar footer, the mobile Profile footer and the
// landing page footer so the link target and image live in one place.
// The PNG (public/arc-studio-badge.png) is a transparent, trimmed pill, so it
// sits correctly on both the light and dark surfaces.
const ARC_STUDIO_URL = 'https://studio.arc.io/'

export function ArcStudioBadge({ width = 112, className }: { width?: number; className?: string }) {
  return (
    <a
      href={ARC_STUDIO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Built with Arc Studio"
      className={className}
      style={{ display: 'inline-flex', flexShrink: 0, lineHeight: 0 }}
    >
      <img decoding="async"
        src="/arc-studio-badge.png"
        alt="Built with Arc Studio"
        width={width}
        style={{ width, height: 'auto', display: 'block' }}
        draggable={false}
      />
    </a>
  )
}
