// Build / dev server for the wallet frame (wallet-frame/) - a separate origin
// from the app. `npm run dev:wallet` serves it on :5174 next to the app's :5173;
// `npm run build:wallet` writes wallet-frame/dist for its own Vercel project.
import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  root: path.resolve(__dirname, 'wallet-frame'),
  envDir: __dirname,
  // Only the frame's own variables reach its bundle - never the app's keys.
  envPrefix: 'VITE_WALLET_',
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
  build: {
    target: 'esnext',
    outDir: path.resolve(__dirname, 'wallet-frame/dist'),
    emptyOutDir: true,
    sourcemap: true,
    // The preload polyfill fetch()es the frame's own chunks; the frame's CSP is
    // connect-src 'none' (it makes no requests at all), so leave it out.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'wallet-frame/index.html'),
        reveal: path.resolve(__dirname, 'wallet-frame/reveal.html'),
      },
    },
  },
})
