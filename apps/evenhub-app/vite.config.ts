import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

// Public env vars (exposed to client) must use `PUBLIC_` prefix.
// e.g. PUBLIC_BACKEND_URL=http://localhost:3000 → import.meta.env.PUBLIC_BACKEND_URL
//
// `@vitejs/plugin-basic-ssl` self-signs a dev TLS cert so the WebView serves
// over HTTPS. Required because `navigator.mediaDevices.getUserMedia` is only
// exposed in a Secure Context — HTTP + a non-localhost IP (Tailscale,
// LAN, etc.) makes `navigator.mediaDevices === undefined`. Cert is cached
// under `node_modules/.vite/basic-ssl/` and only used for dev/preview.
// `/api` is proxied to the local backend so the WebView can fetch a
// same-origin path even when served over HTTPS. Without this, a Secure
// Context page (required for getUserMedia) would block plain HTTP calls
// to `http://<lan-ip>:3000` as Mixed Content.
const BACKEND_PROXY_TARGET =
  process.env['BACKEND_PROXY_TARGET'] ?? 'http://127.0.0.1:3000'

export default defineConfig({
  envPrefix: 'PUBLIC_',
  plugins: [basicSsl()],
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    proxy: {
      '/api': {
        target: BACKEND_PROXY_TARGET,
        changeOrigin: true,
        // Backend runs on plain HTTP locally; the dev cert is self-signed
        // and only applies to the Vite-facing leg of the connection.
        secure: false,
      },
    },
    // When fronted by a reverse proxy (Tailscale Serve, ngrok, etc.) the
    // dev WebSocket can't reach `wss://<LAN-IP>:5173/` directly and falls
    // into a retry loop manifesting as `TypeError: undefined is not an
    // object (evaluating 'ws.send')`. Set VITE_HMR_HOST to the public
    // hostname (e.g. `mac423-watanabe.<tailnet>.ts.net`) and the client
    // will dial `wss://$VITE_HMR_HOST:443/` instead.
    hmr:
      process.env['VITE_HMR_HOST'] !== undefined
        ? { protocol: 'wss', host: process.env['VITE_HMR_HOST'], clientPort: 443 }
        : true,
  },
  preview: {
    port: 5173,
    host: true,
  },
})
