import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'translation-backend',
    environment: 'node',
    include: ['src/**/*.test.ts'],
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
