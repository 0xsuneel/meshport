// Prints one Business element (QR sticker, statement, receipt) on its own:
// the element is mounted straight on <body> as .print-root (see index.css)
// only while the print dialog is open.
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function usePrint() {
  const [node, setNode] = useState<ReactNode>(null)
  const print = (content: ReactNode) => {
    setNode(content)
    // Let React mount it (and images decode) before the dialog opens; some
    // mobile browsers return from print() before printing, so it stays
    // until afterprint.
    const clear = () => setNode(null)
    window.addEventListener('afterprint', clear, { once: true })
    setTimeout(() => window.print(), 350)
  }
  const portal = node ? createPortal(<div className="print-root">{node}</div>, document.body) : null
  return { print, portal }
}
