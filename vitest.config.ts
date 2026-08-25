import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/main/core/**/*.test.ts', 'src/renderer/src/i18n/**/*.test.ts', 'src/renderer/src/lib/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      // 只统计非渲染层核心代码（渲染层已从 coverage 范围排除）。
      include: ['src/main/core/**/*.ts'],
      // 排除入口/仅内置插件（combo 数据用内置插件，无需测试）。
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
      ],
      // 质量门禁：覆盖整个 core（非渲染层）的平均值须超过 70%。
      // 按文件（per-file）不加阈值，避免单个文件红线阻塞，只看总量。
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
    },
  },
})