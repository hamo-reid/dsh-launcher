import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/main/core/**/*.test.ts', 'src/renderer/src/i18n/**/*.test.ts'],
  },
})