# dsh-engram 设计文档：DeepSeek Harness 跨会话记忆插件

日期：2026-09-01。状态：待实现。交付形态：独立新仓库 + 单插件包（对齐 `@kenz1117/dsh-ui-usage-billing` 的 billing 模式，样板见 deepseek-harness 仓库 `packages/client/ui-usage-billing/`）。

## 背景与目标

dsh-engram 为 DeepSeek Harness 提供跨会话长期记忆能力：Agent 在会话与项目之间记住用户偏好、项目约定与经历事实，并随使用持续演化。纯 TypeScript 实现，零外部进程、零 Python 依赖；来源链强制审计、用户级与项目级双层作用域、混合检索、矛盾检测与蒸馏飞轮。

仓库 `kenz1117/dsh-engram`，npm 包 `@kenz1117/dsh-engram`，工具前缀 `engram_`。

## 已确认的决策

技术路线：纯 TypeScript 原生，零 Python 依赖。首版能力：记忆核心 + 自动摄取 + 知识飞轮 + 审计隐私，四项全做。工具集：9 个。作用域：用户级与项目级双层。交付形态：单插件包，包内分层（不拆多 npm 包），接口按可替换抽象设计，未来拆包不改契约。嵌入模型：transformers.js 本地 `Xenova/bge-small-zh-v1.5`，离线、零 API 费用、数据不出机。技术选型吸收 deepseek-harness 仓库未实施计划 `docs/superpowers/plans/2026-08-19-vector-knowledge-base.md` 已验证的部分（node:sqlite、FTS5、transformers.js、bge-small-zh-v1.5），但数据模型独立设计：memory 是带时间、来源、置信、遗忘的经历记忆，不是 knowledge 那样的笔记语义检索。

## 仓库结构（单仓库单插件包，billing 模式）

```
dsh-engram/
  package.json            @kenz1117/dsh-engram：exports（. / ./invariant / ./src/*）、dsh.bundle.patch 清单、peerDependencies
  cordis.patch.yml        bundle patch：dsh plugin add 时以单条目插入 profile 根
  tsdown.config.ts        打包 lib/index.js（host 半）、lib/invariant.js
  tsconfig.json / tsconfig.host.json
  src/
    index.ts              插件入口：Config、apply，注册 store/embedder/工具/摄取钩子（含 session/disposed 末轮摄取）
    types.ts              纯类型：MemoryRecord、MemoryEdge、Query、Hit、EngramError
    config.ts             Config 字段：dbDir、scope 开关、ingest 档位、注入条数与 token 预算、排序 boost 权重、模型缓存目录
    project/
      identity.ts         项目标识：git origin URL 归一化 → sha256 分库名，worktree 指针解析，cwd 兜底与旧库迁移
    store/
      interface.ts        EngramStore 接口（可替换抽象，capability seam 的 Provider 角色）
      sqlite.ts           node:sqlite 实现：节点表 + 边表 + FTS5 + 向量列，单调 SCHEMA_VERSION
    embedder/
      interface.ts        EngramEmbedder 接口
      local.ts            transformers.js + bge-small-zh-v1.5
    retrieve/
      hybrid.ts           向量 + FTS5 融合排序 + 关系一跳扩展
      contradiction.ts    写入时矛盾检测
    flywheel/
      distill.ts          聚类蒸馏与 supersedes 链
      decay.ts            衰减调度
    ingest/
      hook.ts             session 事件流摄取钩子（LLM 提取，档位可配）
    tools/
      definitions.ts      9 个 engram_ 工具 schema 与执行器
      presenter.ts        纯函数 host presenter
    inject.ts             画像注入（ordered dynamic context）
  tests/                  包级 vitest
  README.md
```

## 数据模型

记忆节点字段：`id`（Branded）、`scope`（`user` | `project`）、`kind`（`fact` | `preference` | `decision` | `episode` | `skill`）、`content`、`importance`（0-1）、`confidence`（0-1）、`status`（`active` | `archived` | `forgotten`，遗忘可逆）、`createdAt` / `lastAccessedAt` / `accessCount`、来源链（`sessionId`、`round`、事件 `seq`）、向量与关键词索引。

关系边字段：`from`、`to`、`type`（`supports` | `contradicts` | `refines` | `related` | `supersedes`）、`createdAt`。图能力用于两处：写入时矛盾检测、检索时一跳邻域扩展。

存储：用户级与项目级物理分库，两个 SQLite 文件，位于 Config `dbDir`（默认 harness home 的 engram 目录）。项目库命名 `project-<sha256 前 24 hex>.db`，哈希输入是 git origin URL 归一化（去协议/凭证、host 小写、去尾部 `.git` 与 `/`；worktree 沿 `gitdir:` + `commondir` 指针解析到主仓库 config，纯文件读不起子进程）；无 git 或无 origin 回退 cwd 编码命名，启动时旧 cwd 命名库自动 rename 迁移（新旧并存则不动并告警）。schema 打开时校验单调 `SCHEMA_VERSION`，不兼容拒绝加载，不写兼容 shim。

## 工具集（9 个）

| 工具 | 作用 |
|---|---|
| `engram_save` | 显式保存，指定 kind 与 importance |
| `engram_search` | 向量 + FTS5 融合排序检索（RRF 之上乘 recency/proof boost，权重入 Config），关系一跳扩展，scope 筛选 |
| `engram_timeline` | 时间窗 / 主题查询 |
| `engram_update` | 修正：旧条目建立 supersedes 链，链条保留 |
| `engram_forget` | 软删，可恢复 |
| `engram_review` | 审计：回查记忆的来源链与操作日志 |
| `engram_stats` | 统计：数量、kind 分布、信噪比 |
| `engram_export` | 导出 Markdown / JSON |
| `engram_distill` | 触发蒸馏整理 |

工具 schema 保持窄参数。未知工具卡片在客户端走通用呈现，不阻塞一期；二期再做专用 Web 卡片与管理面板。

## 注入机制

记忆不写入 system prompt。注入走 system-prompt 的 ordered dynamic context（带来源的 user 角色快照），不破坏前缀稳定性与 KV cache 复用。会话开始注入用户级画像摘要（top N 高重要性记忆），Config 可关闭并控制条数；另有 token 预算上限（`injectTokenBudget`，估算 ceil(len/4)，整行超预算跳过不截断，装不下的条目降级为 `#id` 索引行与末尾计数行）。详细内容由模型调用 `engram_search` 获取。

## 自动摄取

挂在 session 事件流：一轮结束后从会话日志提取候选事实（读取源是日志，遵守 model-visible ⟺ logged）；会话结束（`session/disposed` 观察器，fire-and-forget，5 秒超时）补摄取最后一轮，失败/超时把 pending 键写入操作日志，下次会话首次 pre-step 重放补做；已摄取的 (会话, 轮次) 键幂等去重。候选以低 confidence 写入，检索命中时提升。Config 档位 `ingest: off | light | eager`；配置错误在插件加载时 loud 失败；单轮摄取 LLM 失败跳过并计数，不影响主对话。

## 写入时矛盾检测

写入时向量近邻检索 → 疑似矛盾 → 建立 `contradicts` 边 → 在工具结果中报告，由模型或用户裁决。不阻塞写入。

## 知识飞轮

闭环：摄取/保存 → 矛盾检测 → 命中强化（accessCount 与 confidence 提升）→ 蒸馏（同主题簇由 LLM 合并提炼为 skill/fact，原条目 supersedes，新条目继承置信度）→ 衰减（低 importance 且长期未访问 → archived，不参与检索、可恢复、可导出）。蒸馏产物带验证轨迹：被命中且实际支撑回答才提升置信度，支撑失败回退并记录。

## 审计与隐私

每条记忆强制来源链；独立操作日志表记录写入、修改、遗忘；`engram_review` 回查；`engram_export` 导出；Config 提供物理清除。数据可携带、可彻底删除。

## 错误处理

嵌入模型首次下载失败：fail loud 并提示重试；此后检索自动降级 FTS5-only，结果标记"无语义排序"。SQLite schema 不兼容：拒绝加载。摄取失败：跳过该轮并计数。所有配置错误在插件加载时 loud 失败，不静默跳过。

## 构建与分发

tsdown 打包；`cordis.patch.yml` 为 bundle patch 单条目插入；用户以 `dsh plugin add @kenz1117/dsh-engram` 安装，peer 依赖（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-session` 等）由安装流程解析进 profile 的 node_modules，不在插件里引入 Python 或 MCP 桥。Node 引擎 `^22.19.0 || >=24.0.0`。

## 测试策略

vitest 包级测试：store CRUD、supersede 链、scope 隔离、混合排序、衰减调度（不变量断言权威数据，不用固定纯例）；摄取管线用假 LLM fixture；真实组合测试经 Loader 启动测试用 cordis.yml（billing 的 loader-composition 先例）；e2e（需网）真实嵌入模型小样本。注册即 effect、disposer 可逆、store 重复注册报错均测。

## 分期

一期（核心可用）：插件骨架 + SQLite 存储 + 本地嵌入 + 5 个基础工具（save/search/timeline/update/forget）+ 画像注入。
二期（飞轮与审计）：自动摄取 + 矛盾检测 + distill/stats/review/export + 衰减调度。
三期（可选）：Web 管理面板与专用工具卡片（浏览、搜索、编辑、导出记忆库），billing 的 client 半为样板。

## 与 harness 规范的对照

虽为独立仓库，仍遵守 harness 插件规范：capability seam 分层（store/embedder 为接口化 Provider 角色）、注册即 effect 且 disposer 可逆、品牌化 id（`dsh-brand` 思路：包内 Branded 类型）、显式 resolve(request): Spec 默认步骤、无硬编码 tunables（dbDir、ingest 档位、注入条数均为 Config 字段）、misconfiguration fails loud、信任 TypeScript 同进程类型边界（运行时校验只做在 sqlite 与嵌入模型输出边界）、model-visible ⟺ logged、工具 UI 呈现先设计（presenter 纯函数）。包内分层注释与 README 用简体中文。
