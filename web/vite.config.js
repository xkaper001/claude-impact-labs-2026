import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(__dirname, '..', 'engine');

// The deterministic engine lives in ../engine and is plain CommonJS. In DEV,
// Vite only pre-bundles bare-import specifiers, so we alias `@engine` → ../engine
// and list the modules in optimizeDeps.include — esbuild then converts CJS → ESM
// (named + default exports) and serves the cached bundle. In BUILD, Rollup uses
// build.commonjsOptions.include to transform the same files. Either way the
// browser gets the SAME scoring / search / hotspot code the Node CLI uses.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['manifest.webmanifest'],
      manifest: {
        name: 'Setu — Missing Persons Console',
        short_name: 'Setu',
        start_url: '/',
        display: 'standalone',
        background_color: '#0b1220',
        theme_color: '#0b1220',
        lang: 'en',
        categories: ['utilities', 'government'],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,geojson,json}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/tile\.openstreetmap\.org\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'osm-tiles' },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@engine': ENGINE,
      // PouchDB's browser build imports Node's `events` (EventEmitter). Vite
      // externalizes Node builtins for the browser to an empty proxy, which
      // breaks `class X extends EventEmitter`. Alias to the `events` npm shim
      // (pure JS, works in browsers) so PouchDB gets a real constructor.
      events: path.resolve(__dirname, 'node_modules/events/events.js'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  // Dev: force pre-bundling of the CJS engine modules via the @engine alias.
  optimizeDeps: {
    include: [
      '@engine/csv.js',
      '@engine/scoring.js',
      '@engine/geo.js',
      '@engine/search.js',
      '@engine/hotspot.js',
      '@engine/format.js',
      '@engine/prompt.js',
    ],
  },
  // Build: tell Rollup's commonjs plugin to also transform ../engine/*.js
  // (it only processes node_modules by default).
  build: {
    commonjsOptions: {
      include: [/[/\\]engine[/\\].*\.js$/u, /node_modules/],
      transformMixedEsModules: true,
    },
  },
});
