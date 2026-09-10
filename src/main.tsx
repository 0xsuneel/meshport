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
import './store/themeStore'

// Clear all legacy mock/fake data from localStorage on startup
clearLegacyData()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
