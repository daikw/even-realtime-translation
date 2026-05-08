import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'evenhub-app',
    // jsdom because we mock browser APIs (Even bridge, WebRTC) in unit tests.
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/even/**/*.ts'],
      // Mocks (`*.mock.ts`) and barrel re-exports are exercised via dependents,
      // so excluding them keeps the coverage signal focused on real logic.
      exclude: ['src/even/**/*.test.ts', 'src/even/**/*.mock.ts', 'src/even/index.ts'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
})
