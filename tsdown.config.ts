import { clientBundle } from './scripts/clientBundle.ts'

// 双 face 构建包工厂（billing 的 vendored 副本，专为仓库外插件设计）：
// - node 半：src/index.ts 直打 lib/index.js（esm）
// - client 半：src/client/index.ts 打包 lib/client.js（cjs closure-factory，
//   minify，平台 8 项 external，CSS Modules 内联）
// face-undefined（不传 DSH_BUILD_FACE）一次产出两半。
export default clientBundle('@kenz1117/dsh-engram', ['src/index.ts'], {
  lib: { dts: false },
})
