import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'translation-backend',
    environment: 'node',
    // `tests/integration/*.test.ts` boots a real Fastify instance and drives
    // the WebView `apiClient` over HTTP. Kept out of `src/` so package unit
    // globs and coverage rules aren't disturbed.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // index.ts is the runtime entry that calls listen(); not unit-testable
      // without spawning a real server. The buildServer() factory in server.ts
      // is exercised by the route tests, so coverage thresholds focus there.
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
})
