import { clientBundle } from './scripts/clientBundle.ts'

// 双 face 构建包工厂（billing 的 vendored 副本，专为仓库外插件设计）：
// - node 半：src/index.ts 直打 lib/index.js（esm）。另有一个独立单入口构建把
//   src/embedder/local.ts 打成 lib/local.js（entry 用对象形式钉名字）：
//   0.13.11 引擎出树后，随包引擎（lib/engine/）只经这个入口装载——插件入口的
//   导出面是宿主契约（name/apply/inject…），嵌入器不能挂上去；单独构建还能
//   避免多入口共享模块被 rolldown 拆成带哈希的中间 chunk，lib/ 里必须只有
//   稳定文件名。scripts/backfill-embeddings.mjs 与 scripts/engine-smoke.mjs
//   从 lib/local.js 进。
// - client 半：src/client/index.ts 打包 lib/client.js（cjs closure-factory，
//   minify，平台 8 项 external，CSS Modules 内联）
// face-undefined（不传 DSH_BUILD_FACE）一次产出两半。
export default clientBundle('@kenz1117/dsh-engram', ['src/index.ts'], {
  lib: { dts: false },
  companions: [{
    name: '@kenz1117/dsh-engram/embedder',
    entry: { local: 'src/embedder/local.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }],
})
