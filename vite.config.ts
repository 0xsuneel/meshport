import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'

// build: 20250615
export default defineConfig({
  server: {
    proxy: {
      // All /api/* calls proxy to Vercel deployment.
      // relay-rpc, relay-gas, relay-deposit are serverless functions on Vercel.
      // Deploy to Vercel first, then npm run dev works with live API routes.
      '/api': {
        target: 'https://meshportweb.vercel.app',
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
        manualChunks: {
          'viem':         ['viem', 'viem/accounts'],
          'ethers':       ['ethers'],
          'circle-sdk':   ['@circle-fin/app-kit', '@circle-fin/adapter-ethers-v6'],
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'motion':       ['framer-motion'],
        },
      },
    },
  },
  plugins: [
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
      },
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],
      manifest: {
        name: 'MeshPort - USDC Payments',
        short_name: 'MeshPort',
        description: 'One Gateway Every Chain',
        theme_color: '#12665F',
        background_color: '#0B0E11',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
})
