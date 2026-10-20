// Phone / browser Back for things that open over a page without changing the
// route: the Business screens, their sheets, Manage orders / money.
//
// Each open layer holds one history entry (same URL). Back pops it and runs
// the top layer's own back - the same as its on-screen arrow or a tap on the
// dim - so Back walks out one layer at a time instead of leaving the page
// (on a tab, BottomNav would jump to Home). A layer closed on screen drops
// its entry again. Same idea as Pay's steps (PaySendPage), shared.
//
// BottomNav asks `backLayerPop()` and leaves a Back that a layer took.
import { useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'

type Layer = { back: () => void }

const layers: Layer[] = []
/** History entries we pushed and still hold. */
let pushed = 0
/** The page those entries belong to (a route change abandons them). */
let pushedPath = ''
/** Our own history.go() pops still to arrive (not a person's Back). */
let ignorePops = 0
let tookPop = false
let queued = false

function mark() {
  tookPop = true
  setTimeout(() => { tookPop = false }, 0)
}

function sync() {
  queued = false
  if (typeof window === 'undefined') return
  const path = window.location.pathname
  if (pushed > 0 && path !== pushedPath) pushed = 0 // left the page: those entries aren't ours to unwind
  while (pushed < layers.length) {
    if (pushed === 0) pushedPath = path
    window.history.pushState({ ...(window.history.state ?? {}), mpLayer: pushed + 1 }, '')
    pushed += 1
  }
  if (pushed > layers.length) {
    // Closed on screen: drop the entries it held.
    const n = pushed - layers.length
    pushed = layers.length
    ignorePops += 1
    window.history.go(-n)
  }
}

function queueSync() {
  // Batched: a sheet closing as a screen opens (payment → receipt) is one
  // layer either way, so history isn't touched.
  if (queued) return
  queued = true
  queueMicrotask(sync)
}

// Registered when this module loads, before BottomNav's own listener, so a
// Back is marked as taken before BottomNav looks at it.
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (ignorePops > 0) { ignorePops -= 1; mark(); return }
    if (pushed === 0 || window.location.pathname !== pushedPath) return
    pushed -= 1
    mark()
    // Closed now (render + effects), so the count below is already right.
    const top = layers[layers.length - 1]
    if (top) flushSync(top.back)
    // A back that only steps inside the layer (a customer → the list), or
    // one the layer refused (busy), keeps it open: hold an entry for it again.
    queueSync()
  })
}

/** This Back was taken by an open layer (BottomNav must leave it alone). */
export function backLayerPop(): boolean {
  return tookPop
}

/** While `active`, phone / browser Back runs `back` (the layer's own close). */
export function useBackLayer(active: boolean, back: () => void) {
  const ref = useRef(back)
  ref.current = back
  useLayoutEffect(() => {
    if (!active) return
    const layer: Layer = { back: () => ref.current() }
    layers.push(layer)
    queueSync()
    return () => {
      const i = layers.indexOf(layer)
      if (i >= 0) layers.splice(i, 1)
      queueSync()
    }
  }, [active])
}
