import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The app tells the user "Your files are processed in this browser. Nothing is
 * uploaded." The ESLint rules in eslint.config.js stop that claim being broken in
 * source; this makes the browser itself enforce it in the shipped build.
 *
 * `connect-src 'none'` is the load-bearing directive: it blocks fetch, XMLHttpRequest,
 * WebSocket, EventSource and sendBeacon outright, including from any dependency. Even
 * if a transitive package tried to phone home, the browser would refuse.
 *
 * Build only -- Vite's dev server needs a websocket to localhost for hot reload.
 */
function strictCspOnBuild(): Plugin {
  const policy = [
    "default-src 'self'",
    "connect-src 'none'",
    "script-src 'self'",
    // Inline style attributes are unavoidable: React sets them, and Recharts sizes
    // every element through them.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    // Nothing in this app submits a form anywhere.
    "form-action 'none'",
  ].join('; ');

  return {
    name: 'gst-strict-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), strictCspOnBuild()],

  /* The engine runs in a Web Worker so the UI never freezes while parsing a large
     register. ES module format keeps the worker's imports identical to the ones the
     Node verification script uses, so both really do run the same code. */
  worker: { format: 'es' },

  build: {
    target: 'es2022',
    /* Fonts and assets stay as real files rather than data URIs, which keeps the
       bundle inspectable -- worth something for a tool whose central claim is that
       you can verify what it does. */
    assetsInlineLimit: 0,
  },

  server: { open: false },
});
