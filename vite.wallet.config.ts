// Build / dev server for the wallet frame (wallet-frame/) - a separate origin
// from the app. `npm run dev:wallet` serves it on :5174 next to the app's :5173;
// `npm run build:wallet` writes wallet-frame/dist for its own Vercel project.
import { defineConfig, type Plugin } from 'vite'
import { readFileSync } from 'fs'
import path from 'path'

// The MPC module (src/wallet/mpc/meshport_mpc.wasm) as base64 inside the
// worker's bundle: the frame's CSP is connect-src 'none', so it can't be
// fetched as a file. Imported as 'virtual:meshport-mpc-wasm'.
function mpcWasmInline(): Plugin {
  const id = 'virtual:meshport-mpc-wasm'
  const file = path.resolve(__dirname, 'src/wallet/mpc/meshport_mpc.wasm')
  return {
    name: 'meshport-mpc-wasm',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(resolved) {
      if (resolved !== `\0${id}`) return null
      this.addWatchFile(file)
      return `export default ${JSON.stringify(readFileSync(file).toString('base64'))}`
    },
  }
}

export default defineConfig({
  root: path.resolve(__dirname, 'wallet-frame'),
  envDir: __dirname,
  // Only the frame's own variables reach its bundle - never the app's keys.
  envPrefix: 'VITE_WALLET_',
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { port: 5174, strictPort: true },
  preview: { port: 5174, strictPort: true },
  plugins: [mpcWasmInline()],
  // The MPC worker (wallet-frame/src/mpcWorker.ts), an ES module worker; its
  // bundle needs the same plugin.
  worker: { format: 'es', plugins: () => [mpcWasmInline()] },
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
        passkey: path.resolve(__dirname, 'wallet-frame/passkey.html'),
      },
    },
  },
})
