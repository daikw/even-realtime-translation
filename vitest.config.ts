import { defineConfig } from 'vitest/config'

// Root config for vitest. `pnpm test` invokes vitest in each workspace package
// via `pnpm -r test`, so the only role here is to declare the projects when
// running `vitest` from the root.
export default defineConfig({
  test: {
    projects: [
      './apps/*/vitest.config.ts',
      './services/*/vitest.config.ts',
      './packages/*/vitest.config.ts',
    ],
  },
})
