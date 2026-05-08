import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'evenhub-app',
    // jsdom because we mock browser APIs (Even bridge, WebRTC) in unit tests.
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
