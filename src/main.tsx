import { Buffer } from 'buffer'
if (typeof window !== 'undefined') (window as any).Buffer = Buffer


// Suppress Circle SDK telemetry CORS errors — these are internal Circle logging
// calls that fail in localhost due to CORS. They don't affect functionality.
const _origFetch = window.fetch.bind(window)
window.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  if (url?.includes('api.circle.com') && url?.includes('/logs')) {
    return Promise.resolve(new Response('{}', { status: 200 }))
  }
  return _origFetch(input, init)
} as typeof fetch

// Suppress Circle SDK telemetry CORS errors on localhost
// The SDK sends logs to api.circle.com which blocks x-user-agent header from localhost
const _originalFetch = window.fetch.bind(window)
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
  if (url?.includes('api.circle.com') && url?.includes('/logs')) {
    return Promise.resolve(new Response('{}', { status: 200 }))
  }
  return _originalFetch(input, init)
}) as typeof fetch

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { clearLegacyData } from './lib/clearLegacyData'
import { recoverFromStaleBuild, markBuildHealthy } from './lib/lazyRetry'

// A chunk preload failing (app updated while this tab was open) → reload onto
// the new build instead of crashing. Once the app has run fine for a bit,
// reset the retry counter so the next deploy gets fresh retries too.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault()
  recoverFromStaleBuild()
})
window.setTimeout(markBuildHealthy, 15_000)
import './store/themeStore'

// Clear all legacy mock/fake data from localStorage on startup
clearLegacyData()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
