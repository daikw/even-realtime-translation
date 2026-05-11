import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'evenhub-app',
    // jsdom because we mock browser APIs (Even bridge, WebRTC) in unit tests.
    environment: 'jsdom',
    // `tests/` holds cross-layer integration suites (state+hud, App lifecycle).
    // Keeping them out of `src/` avoids polluting per-module unit globs while
    // still running under the same vitest project.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/even/**/*.ts',
        'src/realtime/**/*.ts',
        'src/hud/**/*.ts',
        'src/state/**/*.ts',
        'src/backend/**/*.ts',
        'src/audio/**/*.ts',
        'src/config.ts',
        'src/app.ts',
      ],
      // Mocks (`*.mock.ts`) and barrel re-exports are exercised via dependents,
      // so excluding them keeps the coverage signal focused on real logic.
      // `main.ts` is the auto-boot wrapper around `App`; covered by App tests.
      exclude: [
        'src/even/**/*.test.ts',
        'src/even/**/*.mock.ts',
        'src/even/index.ts',
        'src/realtime/**/*.test.ts',
        'src/realtime/index.ts',
        'src/hud/**/*.test.ts',
        'src/hud/index.ts',
        'src/state/**/*.test.ts',
        'src/backend/**/*.test.ts',
        'src/audio/**/*.test.ts',
        'src/app.test.ts',
        'src/config.test.ts',
        'src/main.ts',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
})
