import { defineConfig } from 'tsdown'

// host 半打包：workspace 与嵌入运行时依赖一律不打包（neverBundle），
// lib 产物只含本包代码，依赖由 dsh plugin add 装进 profile node_modules。
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  outDir: 'lib',
  dts: true,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^@huggingface\//, /^onnxruntime/],
  },
})
