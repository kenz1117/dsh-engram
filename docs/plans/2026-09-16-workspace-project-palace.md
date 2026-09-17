# 项目宫殿随工作区切换（面板显示 + 工具按会话 cwd）

动机：面板「项目」scope 一直是**插件进程目录**那一个分库（`apply()` 时算一次
`resolveProjectIdentity(process.cwd())` 并固定），于是：① 在 GUI 里切换工作区时项目宫殿不变；
② 界面从不显示"当前项目宫殿属于哪个工作区"；③ `engram_save/search` 默认 project 也落进程目录，
与自动摄取（已按会话 cwd 逐条判宫殿）口径不一致。

## 设计

1. **来源三级、零状态**（`src/project/registry.ts`）：宿主 `ctx.workspaceRegistry.list()`
   （web profile 已装载，dsh-web-app 的 peer）提供规范路径 + 标题；其次是 `sessionPersistence`
   header 里出现过的 cwd（历史回填建的库也能被认领）；最后是插件进程目录兜底。每次现算
   `目录 → 分库名`，不维护额外注册表文件——工作区改名/删除后清单自动跟上。按分库名去重，
   因此同仓库的多个 worktree 共用一个项目宫殿。
2. **API 参数化**（`src/routes.ts`）：新增 `GET /api/engram/workspaces`（清单 + 进程默认项，
   库文件不存在时不打开、不建空库）；所有项目 scope 的 GET 接受 `?project=<dbName>`、POST 接受
   body `project`；缺省 = 进程目录兜底（向后兼容）；未知选择器抛 `UnknownProjectError` →
   统一 404 `{error:"unknown project"}`，面板据此回退「跟随当前工作区」。
3. **工具按会话 cwd**（`src/tools/create.ts`）：`ToolDeps` 增 `resolveProjectStore(cwd)`；
   `createEngramTools` 内用 **AsyncLocalStorage** 把执行期会话 cwd 暴露给门面 `deps`——
   `openStore('project')` 转成 `resolveProjectStore(execSessionCwd.getStore())`，所有 handler
   与闭包助手无需逐处改调用点；用 ALS 而不是模块级变量，避免并发会话串味。
   `sessionCwdOf(exec)` 取 `exec.agent.session.header.cwd`，取不到回退进程目录。
4. **旧命名迁移**（`src/project/identity.ts`）：cwd 兜底命名从「cwd hex 前 24 位（只覆盖前 12 个
   字符，同前缀目录撞库）」改为「cwd 全量 sha256 前 24 位」；`migrateProjectDb` 的迁移条件不再
   限 origin 源（`dbName !== legacyDbName` 即可），启动/首次打开时 rename 旧库；新旧并存不动并
   告警（旧截断名可能被同前缀的多个目录共用，归属只能靠人工）。
5. **卸载关库**：`ctx.effect` 的 disposer 关闭所有已缓存分库连接（windows 上不关会锁住 .db，
   卸载后目录删不掉）；顺带修掉 composition 测试长期存在的 EBUSY 清理失败。
6. **client 半**：面板读 `ctx.workspaces` / `ctx.sessions`（可选服务）算「当前工作区」，
   `library.project` = `'follow' | dbName` 持久化选择；`api()` 是唯一请求出口，按作用域
   project 自动注入选择器（GET 拼 query / POST 补 body），Header 三宫格右侧显示
   `项目 · 跟随 <工作区标题>`，project scope 下提供工作区下拉（含记忆条数）。

## 影响面

- host：`src/project/registry.ts`（新）、`src/project/identity.ts`、`src/routes.ts`、
  `src/index.ts`（清单装配 / 路由依赖 / 衰减调度覆盖各工作区 / 卸载关库）、`src/tools/create.ts`。
- client：`src/client/EngramPanel.tsx`、`src/client/index.ts`、`src/client/locales.ts`、
  `src/client/panel.module.css`。
- 测试：`tests/registry.spec.ts`（新）、`tests/identity.spec.ts`（迁移与撞库）、
  `tests/tools.spec.ts`（会话 cwd 归属）、`tests/composition.spec.ts`（`/workspaces` + `?project=` 全链路）。

## 不做

- 不新增配置开关（口径内置；进程目录兜底即旧行为）。
- 不加 sidecar 注册表文件：已删工作区的库只能显示哈希名，需要时再说。
- 画像注入仍只读私人库（本次不动）。
