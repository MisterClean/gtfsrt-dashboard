import {defineConfig} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {contentSecurityPolicy, securityHeaders} from './scripts/security.mjs';

// Relative paths let the same build run beneath /gtfsrt-dashboard/ or anywhere else.
export default defineConfig({
  base: './',
  plugins: [svelte()],
  worker: {format: 'es'},
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    reportCompressedSize: false,
  },
  // Vite's hot reload injects styles, which the production policy forbids.
  server: {
    headers: {...securityHeaders, 'Content-Security-Policy': contentSecurityPolicy.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'").replace("connect-src 'self'", "connect-src 'self' ws:")},
    port: 4175,
    strictPort: false,
    fs: {allow: ['.']},
  },
  preview: {headers: securityHeaders},
  optimizeDeps: {exclude: ['@duckdb/duckdb-wasm']},
});
