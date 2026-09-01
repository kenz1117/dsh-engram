import { defineConfig } from 'vitest/config'

// @deepseek-ai/* 依赖经 file: 协议（hoisted node_modules）解析到 deepseek-harness 构建产物，
// 发布形态下这些包是 peerDependencies，由 dsh profile 的 node_modules 提供。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30_000,
  },
})
