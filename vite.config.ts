import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'

// Build id: baked into the app (__MP_BUILD__) and published as /version.json,
// so an open app can tell within a minute that a newer deploy is live
// (lib/swUpdate.ts) - a ~50-byte check instead of waiting for the service
// worker to download the whole new offline copy.
const MP_BUILD = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 12) || Date.now().toString(36)
const mpVersionFile = {
  name: 'mp-version-file',
  generateBundle(this: { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void }) {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: MP_BUILD }) })
  },
}

// ── The service worker's core: what the first screen needs ────────────────
// Like m.uber / Twitter Lite: on install the service worker stores only the
// files the first screen needs (the app's start files, Home, the landing and
// sign-in pages, styles, fonts, icons). Every other screen is stored the
// first time it opens (CacheFirst in sw.ts). Storing all ~290 files (6.5 MB)
// took ~3.6 min on 2G and was all-or-nothing: closing the app before it
// finished saved nothing, and the download shared the 2G link with payments.
const CORE_CHUNKS = new Set(['HomePage', 'LandingPage', 'AuthPages', 'PasscodeSetup', 'swUpdate'])
const CORE_MAX_STATIC_BYTES = 40 * 1024 // big pictures (share image, badge) are stored when shown
const coreFiles = new Set<string>()
const mpCoreFiles = {
  name: 'mp-core-files',
  writeBundle(_: unknown, bundle: Record<string, { type: string; fileName: string; name?: string; isEntry?: boolean; imports?: string[] }>) {
    if (!bundle['index.html']) return // only the app's own build (not the service worker's)
    coreFiles.clear()
    const add = (file: string) => {
      if (coreFiles.has(file)) return
      coreFiles.add(file)
      for (const i of bundle[file]?.imports ?? []) add(i)
    }
    for (const c of Object.values(bundle)) {
      if (c.type === 'chunk' && (c.isEntry || (c.name && CORE_CHUNKS.has(c.name)))) add(c.fileName)
    }
  },
}
/** injectManifest transform: keep the core scripts and every small non-script file. */
function coreOnly(entries: { url: string; size: number; revision: string | null }[]) {
  const manifest = entries.filter(e => {
    const url = e.url.replace(/^\//, '')
    if (url.endsWith('.js')) return coreFiles.size === 0 || coreFiles.has(url) || !url.startsWith('assets/') // boot.js, registerSW.js
    // Fonts for other alphabets load only when such text shows (unicode-range).
    if (url.endsWith('.woff2')) return !/geist-(cyrillic|vietnamese|latin-ext)/.test(url)
    return url.endsWith('.css') || url.endsWith('.html') || e.size <= CORE_MAX_STATIC_BYTES
  })
  return { manifest, warnings: coreFiles.size === 0 ? ['mp-core-files: no bundle graph - storing every script'] : [] }
}

// build: 20250615
export default defineConfig({
  server: {
    proxy: {
      // All /api/* calls proxy to the production deployment.
      // relay-rpc, relay-gas, relay-deposit are serverless functions on Vercel,
      // served in production behind the meshport.xyz custom domain.
      // Deploy to Vercel first, then npm run dev works with live API routes.
      '/api': {
        target: 'https://meshport.xyz',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Polyfill Node.js built-ins for browser — needed by ethers/viem/Circle SDK
      buffer: 'buffer',
    },
  },
  define: {
    global: 'globalThis',
    'process.env': {},
    __MP_BUILD__: JSON.stringify(MP_BUILD),
  },
  optimizeDeps: {
    include: [
      'buffer',
      'viem',
      'viem/accounts',
      'ethers',
      '@circle-fin/app-kit',
      '@circle-fin/adapter-viem-v2',
      '@circle-fin/adapter-ethers-v6',
    ],
    esbuildOptions: {
      target: 'esnext',
      define: {
        global: 'globalThis',
      },
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        // The Node polyfills (Buffer, process) get their own small chunk. With
        // the plain list form Rollup put Buffer inside the circle-sdk chunk,
        // and since the app's entry needs Buffer, every app open downloaded
        // and parsed the whole Circle SDK + ethers (~1.4 MB) before the first
        // screen - even though only Multichain/Swap use them.
        manualChunks(id) {
          // Vite's dynamic-import preload helper: every lazy import goes
          // through it, so Rollup put it in a chunk the entry shares with a
          // lazy screen - the viem chunk - and every app open downloaded all
          // of viem just for this one tiny function. Keep it with the
          // polyfills, which load at start anyway.
          if (id.includes('vite/preload-helper')) return 'polyfills'
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/(buffer|base64-js|ieee754|process|vite-plugin-node-polyfills)\//.test(id)) return 'polyfills'
          if (/node_modules\/viem\//.test(id)) return 'viem'
          if (/node_modules\/ethers\//.test(id)) return 'ethers'
          // The small crypto primitives (x25519 for chat keys, hashes) are shared
          // with the app itself. Left unassigned, Rollup put them inside the
          // circle-sdk chunk (Circle's SDK uses them too), so setting up chat
          // keys at app start downloaded, parsed and ran the whole 1.4 MB
          // Circle + Solana + Anchor bundle (~290 ms of main-thread work on a
          // mid-range phone, while Home was drawing). Their own small chunk.
          if (/node_modules\/@noble\//.test(id)) return 'noble'
          if (/node_modules\/@circle-fin\/(app-kit|adapter-ethers-v6)\//.test(id)) return 'circle-sdk'
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return 'react-vendor'
          if (/node_modules\/framer-motion\//.test(id)) return 'motion'
          return undefined
        },
      },
    },
  },
  plugins: [
    mpVersionFile,
    mpCoreFiles,
    react(),
    // Circle SDK (and some of its transitive deps) reference `Buffer` as an
    // ambient Node global at module top-level — the manual `window.Buffer =
    // Buffer` polyfill in main.tsx runs too late to catch this: ES modules
    // evaluate all static imports (main.tsx's own import of App, and
    // everything App transitively imports, including the Circle SDK chunk)
    // BEFORE the importing file's own top-level code runs, regardless of
    // where that code is textually positioned in the file. This plugin
    // injects the polyfill at the bundler level instead, so it's genuinely
    // available before any module code — including third-party top-level
    // code — executes, rather than depending on JS's own import evaluation
    // order. Kept alongside (not instead of) the existing resolve.alias +
    // main.tsx polyfill below, which still correctly handle explicit
    // `import { Buffer } from 'buffer'` call sites.
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        manifestTransforms: [coreOnly],
      },
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-any-192x192.png', 'pwa-any-512x512.png', 'notification-icon.png'],
      manifest: {
        name: 'MeshPort - USDC Payments',
        short_name: 'MeshPort',
        description: 'One Gateway Every Chain',
        // The installed PWA's Android system bars - notably the BOTTOM
        // navigation/gesture bar - take a STATIC colour from the manifest and
        // (unlike the top bar, which follows the live <meta name="theme-color">)
        // do NOT change with the in-app light/dark theme. With theme_color black
        // and background_color brand teal the bar still showed teal under the
        // app, so both are the light page ground (--bg): the bar matches the
        // default light theme, and the launch screen is the same light ground
        // behind the logo tile. No manifest value can follow the theme.
        theme_color: '#F5F4F0',
        background_color: '#F5F4F0',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          // ONE non-maskable icon on purpose: Android uses the maskable icon
          // for BOTH the home-screen icon and the launch screen, so a maskable
          // icon can't give a white home icon AND a small launch-screen logo.
          // This one is a small white logo tile on a transparent canvas: on
          // the teal background_color it draws as a small tile (launch screen);
          // the launcher puts it on its own backdrop (home screen).
          // To go back to the old look: restore the two 'maskable' entries
          // (pwa-192x192.png / pwa-512x512.png, white full-bleed) and the old
          // pwa-any-*.png files from git history.
          { src: 'pwa-any-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-any-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
    }),
  ],
})
