// Android (Chrome / Edge): the phone keyboard slides OVER the app instead of
// resizing its window.
//
// With interactive-widget=resizes-content (still in index.html, the fallback
// for browsers without this API), Android resizes the whole window when the
// keyboard opens or closes. The app is then laid out again a frame or more
// later, so the page jumped, and Android filled the gap with the installed
// app's background colour (the teal flash). Native apps never resize: the
// keyboard covers the window and the app makes room itself.
//
// The VirtualKeyboard API gives a web app the same: overlaysContent = true
// stops the resize, and navigator.virtualKeyboard.boundingRect says where the
// keyboard is. The app frame (useVisibleFrame) shrinks by its height, and
// popups pad themselves with env(keyboard-inset-height). Switched on only
// while such a frame is mounted - see holdKeyboardOverlay below.
//
// Chromium only - iPhone (WebKit) has no such API and keeps following
// window.visualViewport.

type VirtualKeyboard = EventTarget & { overlaysContent: boolean; boundingRect: DOMRectReadOnly }

export function virtualKeyboard(): VirtualKeyboard | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard ?? null
}

/** Height of the keyboard drawn over the app, in CSS px (0 when closed or not overlaid). */
export function keyboardInset(): number {
  const vk = virtualKeyboard()
  return vk?.overlaysContent ? Math.max(0, vk.boundingRect.height) : 0
}

/**
 * Keyboard drawn over the page - ONLY while an app frame that makes room for
 * it is mounted (useVisibleFrame: AppLayout, AuthShell). Pages outside one
 * (admin panel, landing, error screens) never shrink themselves, so for them
 * the browser keeps resizing the page and scrolling the field into view -
 * with overlay on everywhere, the admin login's password field sat under the
 * keyboard. Counted, so two frames mounting/unmounting in either order can't
 * switch it off under each other. Phones and tablets only.
 */
let overlayUsers = 0
// Switched off for good by the app frame (useVisibleFrame). Android browsers
// and webviews (Via, in-app browsers) report this API unreliably: the keyboard
// rect stayed non-zero after the keyboard closed, or was subtracted on top of
// a window the browser had already shrunk - the chat sat in the top half with
// a blank band under it (19 Nov). The browser's own resize (interactive-widget
// =resizes-content) is what every Android browser does right, so the frame
// follows that instead.
let overlayDisabled = false
export function disableKeyboardOverlay(): void {
  overlayDisabled = true
  const vk = virtualKeyboard()
  try { if (vk) vk.overlaysContent = false } catch { /* ignore */ }
}

export function holdKeyboardOverlay(): () => void {
  if (overlayDisabled) return () => {}
  const vk = virtualKeyboard()
  let coarse = false
  try { coarse = window.matchMedia('(pointer: coarse)').matches } catch { /* no matchMedia */ }
  if (!vk || !coarse) return () => {}
  overlayUsers++
  try { vk.overlaysContent = true } catch { /* not supported: the browser keeps resizing */ }
  let released = false
  return () => {
    if (released) return
    released = true
    overlayUsers = Math.max(0, overlayUsers - 1)
    if (overlayUsers === 0) { try { vk.overlaysContent = false } catch { /* ignore */ } }
  }
}
