import { defineConfig } from 'tsdown'

// host 半打包：workspace 与嵌入运行时依赖一律 external，
// lib/index.js 只含本包代码，依赖由 dsh plugin add 装进 profile node_modules。
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  dts: true,
  external: [/^@deepseek-ai\//, /^@huggingface\//, /^onnxruntime/],
})
