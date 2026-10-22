import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'path';
// Build id: baked into the app (__MP_BUILD__) and published as /version.json,
// so an open app can tell within a minute that a newer deploy is live
// (lib/swUpdate.ts) - a ~50-byte check instead of waiting for the service
// worker to download the whole new offline copy.
var MP_BUILD = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 12) || Date.now().toString(36);
var mpVersionFile = {
    name: 'mp-version-file',
    generateBundle: function () {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: MP_BUILD }) });
    },
};
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
                manualChunks: function (id) {
                    if (!id.includes('node_modules'))
                        return undefined;
                    if (/node_modules\/(buffer|base64-js|ieee754|process|vite-plugin-node-polyfills)\//.test(id))
                        return 'polyfills';
                    if (/node_modules\/viem\//.test(id))
                        return 'viem';
                    if (/node_modules\/ethers\//.test(id))
                        return 'ethers';
                    if (/node_modules\/@circle-fin\/(app-kit|adapter-ethers-v6)\//.test(id))
                        return 'circle-sdk';
                    if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id))
                        return 'react-vendor';
                    if (/node_modules\/framer-motion\//.test(id))
                        return 'motion';
                    return undefined;
                },
            },
        },
    },
    plugins: [
        mpVersionFile,
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
            includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-any-192x192.png', 'pwa-any-512x512.png', 'notification-icon.png'],
            manifest: {
                name: 'MeshPort - USDC Payments',
                short_name: 'MeshPort',
                description: 'One Gateway Every Chain',
                // The installed PWA's Android system bars - notably the BOTTOM
                // navigation/gesture bar - take a STATIC colour from the manifest and
                // (unlike the top bar and browser tabs, which follow the live
                // <meta name="theme-color">) do NOT change with the in-app light/dark
                // theme. Chrome uses theme_color for that bar, falling back to
                // background_color when it's absent - so brand teal in either slot
                // left a teal band under the app. There is no manifest value that can
                // follow the theme, so pin it to the dark app background: a neutral
                // dark strip that matches dark mode and is unobtrusive in light mode,
                // instead of off-brand teal. The live status bar still follows the
                // in-app theme via #mp-theme-color. background_color stays brand teal
                // for the native launch-screen tile behind the logo.
                theme_color: '#0B0E11',
                background_color: '#0F5C57',
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
});
