import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'translation-backend',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
