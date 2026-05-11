import { defineConfig } from 'vite'

// Public env vars (exposed to client) must use `PUBLIC_` prefix.
// e.g. PUBLIC_BACKEND_URL=http://localhost:3000 → import.meta.env.PUBLIC_BACKEND_URL
export default defineConfig({
  envPrefix: 'PUBLIC_',
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 5173,
  },
})
