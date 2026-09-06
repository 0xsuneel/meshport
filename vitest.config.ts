import { defineConfig } from 'vitest/config'
import path from 'path'

// Deliberately standalone rather than merging vite.config.ts: the app config
// pulls in the PWA service-worker plugin, the React plugin and the Node
// polyfills, none of which a unit test needs — loading them would only add
// per-run cost and give the service-worker build a reason to run during tests.
// The `@` alias is the single piece of app config the tests actually depend on,
// so it is the single piece repeated here. Keep it in sync with vite.config.ts.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // These are pure-logic tests — no DOM, so no jsdom/happy-dom dependency.
    environment: 'node',
    // src/**: the app's browser-bundled code. server/**: transaction-service
    // code that must never be part of the Vite/browser bundle (see
    // docs/TRANSACTION_SERVICE_BOUNDARY.md) but is still unit-tested the
    // same way via the same vitest run.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
  },
})
