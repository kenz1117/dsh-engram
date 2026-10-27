import { defineConfig } from 'vitest/config'

// @deepseek-ai/* 依赖经 file: 协议（hoisted node_modules）解析到 deepseek-harness 构建产物，
// 发布形态下这些包是 peerDependencies，由 dsh profile 的 node_modules 提供。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // client/ 目前零测试（审计 §7 已入册的盲区）：先不计入阈值，防止 6k 行面板把
      // 棘轮压死在地板上。client 测试落地后把这条排除收窄。
      exclude: ['src/client/**', 'lib/**'],
      // 棘轮（2026-10-27 基线：stmts 77.9 / branch 69.6 / funcs 75.8 / lines 80.9）：
      // 低于基线的阈值起步，覆盖率只升不降——新增代码拉低整体都会在这里响。
      thresholds: { lines: 80, functions: 75, branches: 69, statements: 77 },
    },
  },
})
