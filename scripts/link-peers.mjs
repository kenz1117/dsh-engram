#!/usr/bin/env node
/**
 * 把本插件的 @deepseek-ai/* peer 依赖从 deepseek-harness 工作区 symlink 进 node_modules。
 *
 * 为什么不用 file:/npm 安装：harness 内部包的 dependencies 使用 workspace:^ 协议，
 * 脱离其工作区无法经 pnpm 解析；npm 上的 @deepseek-ai 依赖链也不完整（dsh-type-meta 未发布）。
 * symlink 后，被链接包内部对其他 @deepseek-ai/* 的 import 会沿真实路径（harness 树内）
 * 向上解析到 harness 自己的 workspace node_modules，传递链自动闭合。
 *
 * 前置：deepseek-harness 已执行 pnpm install && pnpm run build（存在 lib/ 产物）。
 * 幂等：已存在的链接跳过。发布形态下这些包是 peerDependencies，由 dsh profile 提供。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = resolve(repoRoot, '..', 'deepseek-harness')

/** 直接 import 的包：类型与运行时的真实入口；其传递依赖由 harness 树内解析闭合。 */
const LINKED_PACKAGES = [
  ['@deepseek-ai/cordis', 'vendor/cordis'],
  ['@deepseek-ai/cosmokit', 'vendor/cosmokit'],
  ['@deepseek-ai/schemastery', 'vendor/schemastery'],
  ['@deepseek-ai/dsh-tools', 'packages/core/tools'],
  ['@deepseek-ai/dsh-llm', 'packages/llm/llm'],
  ['@deepseek-ai/dsh-agent', 'packages/core/agent'],
  ['@deepseek-ai/dsh-scope', 'packages/core/scope'],
  ['@deepseek-ai/dsh-util-values', 'packages/util/values'],
  ['@deepseek-ai/dsh-brand', 'packages/util/brand'],
  ['@deepseek-ai/dsh-invariants', 'packages/runtime-diagnostics/invariants'],
]

const scopeDir = join(repoRoot, 'node_modules', '@deepseek-ai')
mkdirSync(scopeDir, { recursive: true })

let created = 0
for (const [name, rel] of LINKED_PACKAGES) {
  const target = join(harnessRoot, rel)
  const link = join(scopeDir, name.split('/')[1])
  if (existsSync(link)) continue
  if (!existsSync(target)) {
    console.error(`[link-peers] 缺少 ${target}：请先在 deepseek-harness 执行 pnpm install && pnpm run build`)
    process.exitCode = 1
    continue
  }
  symlinkSync(target, link, 'dir')
  created += 1
}
console.log(`[link-peers] ok（新建 ${created} 个链接，共 ${LINKED_PACKAGES.length} 个 peer）`)
