import { useId } from 'react'

// ── MeshPort action icons (Home buttons, More sheet, Quick Actions, sidebar) ──
// One drawn set on a 24 grid: solid shapes with the details cut out (the $,
// the gift ribbon, the globe lines…), Pay as a rounded line plane. Each glyph
// is mask content: white = ink, black = cut-out. The mask paints one rect in
// `color`, so the icon takes any colour, cut-outs show the background.
export type ActionIconName = 'pay' | 'receive' | 'swap' | 'more' | 'bulk' | 'hub' | 'p2p' | 'rewards' | 'insights' | 'clock'

// Static markup written here (never user data).
const GLYPHS: Record<ActionIconName, string> = {
  pay: "<path d=\"M20 4.2 4.2 9.2l7.2 3.4 3.4 7.2z\" fill=\"none\" stroke=\"#fff\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2.2\"/><path d=\"M11.4 12.6l3.8-3.8\" fill=\"none\" stroke=\"#fff\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2.2\"/>",
  receive: "<circle cx=\"13.6\" cy=\"6.6\" r=\"5\" fill=\"#fff\"/><rect x=\"2\" y=\"13.4\" width=\"2.6\" height=\"7.4\" rx=\"1.3\" fill=\"#fff\"/><path d=\"M6.2 14.4h3.6c1 0 1.9.3 2.6.9l.3.3h2.6c.85 0 1.5.65 1.5 1.45l2.6-1.45c.8-.45 1.8-.15 2.1.7.25.65 0 1.35-.6 1.7l-5.4 3.2c-.75.45-1.6.6-2.45.45L6.2 20.2z\" fill=\"#fff\"/><path d=\"M15.05 5.1c-.3-.52-.85-.82-1.46-.82-.9 0-1.57.49-1.57 1.16 0 1.62 3.25.9 3.25 2.47 0 .68-.7 1.2-1.62 1.2-.66 0-1.25-.32-1.57-.84M13.6 3.25v.9M13.6 9.05v.9\" fill=\"none\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"/><path d=\"M11.6 18.3h4.2\" fill=\"none\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"/>",
  swap: "<path d=\"M4.6 11.6v-.9c0-2.5 1.9-4.2 4.5-4.2h5.6\" fill=\"none\" stroke=\"#fff\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2.4\"/><path d=\"M14.3 2.9 19.9 6.5l-5.6 3.6z\" fill=\"#fff\" stroke=\"#fff\" stroke-width=\"1\" stroke-linejoin=\"round\" stroke-width=\"1.4\"/><path d=\"M19.4 12.4v.9c0 2.5-1.9 4.2-4.5 4.2H9.3\" fill=\"none\" stroke=\"#fff\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2.4\"/><path d=\"M9.7 13.9 4.1 17.5l5.6 3.6z\" fill=\"#fff\" stroke=\"#fff\" stroke-width=\"1\" stroke-linejoin=\"round\" stroke-width=\"1.4\"/>",
  more: "<rect x=\"3.2\" y=\"3.2\" width=\"7.6\" height=\"7.6\" rx=\"2.2\" fill=\"#fff\"/><rect x=\"13.2\" y=\"3.2\" width=\"7.6\" height=\"7.6\" rx=\"2.2\" fill=\"#fff\"/><rect x=\"3.2\" y=\"13.2\" width=\"7.6\" height=\"7.6\" rx=\"2.2\" fill=\"#fff\"/><circle cx=\"17\" cy=\"17\" r=\"3.9\" fill=\"#fff\"/>",
  bulk: "<circle cx=\"5.3\" cy=\"9\" r=\"2.5\" fill=\"#fff\"/><circle cx=\"18.7\" cy=\"9\" r=\"2.5\" fill=\"#fff\"/><path d=\"M1.3 18.6c0-2.7 1.7-4.6 4-4.6s4 1.9 4 4.6zM14.7 18.6c0-2.7 1.7-4.6 4-4.6s4 1.9 4 4.6z\" fill=\"#fff\"/><circle cx=\"12\" cy=\"10.2\" r=\"3.2\" fill=\"#fff\" stroke=\"#000\" stroke-width=\"1.6\"/><path d=\"M6.4 20.6c0-3.6 2.4-6 5.6-6s5.6 2.4 5.6 6z\" fill=\"#fff\" stroke=\"#000\" stroke-width=\"1.6\" stroke-linejoin=\"round\"/>",
  hub: "<circle cx=\"12\" cy=\"12\" r=\"9.4\" fill=\"#fff\"/><ellipse cx=\"12\" cy=\"12\" rx=\"3.6\" ry=\"9.4\" fill=\"none\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.6\"/><path d=\"M3.5 8.4h17M3.5 15.6h17\" fill=\"none\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.6\"/>",
  p2p: "<circle cx=\"7.9\" cy=\"7.9\" r=\"3.7\" fill=\"#fff\"/><circle cx=\"16.1\" cy=\"16.1\" r=\"3.7\" fill=\"#fff\"/><path d=\"M13.6 4.4h6v6M10.4 19.6h-6v-6\" fill=\"none\" stroke=\"#fff\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2.3\"/>",
  rewards: "<rect x=\"4\" y=\"11.6\" width=\"16\" height=\"9.2\" rx=\"1.8\" fill=\"#fff\"/><rect x=\"2.8\" y=\"7.2\" width=\"18.4\" height=\"3.6\" rx=\"1.3\" fill=\"#fff\"/><path d=\"M12 7.2C10.8 4.3 7.3 3.4 7.1 5.5 7 7 9.4 7.2 12 7.2zM12 7.2c1.2-2.9 4.7-3.8 4.9-1.7.1 1.5-2.3 1.7-4.9 1.7z\" fill=\"#fff\" stroke=\"#fff\" stroke-width=\"1\" stroke-linejoin=\"round\" stroke-width=\"1.3\"/><path d=\"M12 7.6V21.2M2 11.2h20\" fill=\"none\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.6\"/>",
  insights: "<rect x=\"3.6\" y=\"13\" width=\"4.4\" height=\"7.8\" rx=\"1.4\" fill=\"#fff\"/><rect x=\"9.8\" y=\"9\" width=\"4.4\" height=\"11.8\" rx=\"1.4\" fill=\"#fff\"/><rect x=\"16\" y=\"4.2\" width=\"4.4\" height=\"16.6\" rx=\"1.4\" fill=\"#fff\"/>",
  clock: "<circle cx=\"12\" cy=\"12\" r=\"9.4\" fill=\"#fff\"/><path d=\"M12 6.8v5.4l3.6 2.2\" fill=\"none\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\"/>",
}

export function ActionIcon({ name, size = 26, color = '#fff' }: { name: ActionIconName; size?: number; color?: string }) {
  const id = 'mpa' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block', flexShrink: 0 }}>
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24" dangerouslySetInnerHTML={{ __html: GLYPHS[name] }} />
      <rect width="24" height="24" fill={color} mask={`url(#${id})`} />
    </svg>
  )
}
