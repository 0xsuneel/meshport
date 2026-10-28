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
// popups pad themselves with env(keyboard-inset-height).
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

// Phones and tablets only: a laptop's physical keyboard has nothing to overlay.
try {
  const vk = virtualKeyboard()
  if (vk && window.matchMedia('(pointer: coarse)').matches) vk.overlaysContent = true
} catch { /* not supported: the browser keeps resizing, handled as before */ }
