# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

- npm 包：`@kenz1117/dsh-engram`
- 安装：`dsh plugin --profile web add @kenz1117/dsh-engram`
- 仓库：<https://github.com/kenz1117/dsh-engram>

> **v0.x 阶段的版本约定**：`0.MINOR.PATCH` 里的 `MINOR` 是**功能批次**而不是稳定性刻度——0.7.x 整批是「记忆宫殿信息架构」，0.8.x 整批是「面板重构」，0.9.x 整批是「稳定性与可审计」。同一批次内的 `PATCH` 位通常是修复与加固。

## [Unreleased]

### 文档与市场曝光

- README 首屏重写（中英双语同步）：新增一句话英文定位句「Local-first long-term memory for your coding agent.」、可折叠目录、「为什么是它」三条主流路线对照表、记忆流动 ASCII 流程图、**给 agent 自己装的安装 prompt**；新增 CI 徽章。
- 新增 `docs/store/icon-180.png`（商店卡片位图图标，含可复现的 `icon-180.html` 源）与 `docs/store/social-preview.png`（GitHub 社交预览图，含 `social-preview.html` 源）。
- 新增本 CHANGELOG。
- 修正文档中的工具数量：实际注册 **22** 个 `engram_*` 工具（原文档写作 21，英文版另一处写作 20）。
- `package.json` 补 `homepage` / `bugs` / 更全的 `keywords`。

## [0.9.8] - 2026-10-22

- `pnpm backfill` 新增 `--force`（重建全部向量）与 `--model`（指定模型），扫描 `<dbDir>` 下全部分库（`user.db` / `shared.db` / `project-<hash>.db`）；维度与库中已有向量不符时在写入前报错退出，绝不写出混合维度的库。
- 嵌入器远程端点的离线测试补齐；维度不匹配降级为显式报错而非静默失败。
- 补上 `vite`（vitest 5 把 vite 降成了 peer 依赖）。

## [0.9.7] - 2026-10-22

- 路由层错误分类收敛：超限 413、坏 JSON 400、不是对象 400，三类失败各说各的话；删除重复的 review-answer 处理器。
- i18n：导入失败的措辞去掉「校验失败」叠词；大 body 的报错不再套「文件校验失败」。

## [0.9.6] - 2026-10-21

- 路由级断言补齐三类失败场景；修正「内存封顶」的措辞；修正 `net.connect` 重载（补 `host` 参数）。

## [0.9.5] - 2026-10-21

- **导入不再被 64 KiB body 上限静默丢弃**（#34）：导入接口单独放开到 16 MiB；上限改按**字节**计（原按字符数算，中文一字 3 字节，等于把字节防线悄悄放宽了三倍）；请求体改整块 UTF-8 解码（原逐块解码，多字节字符跨块边界会被切成乱码）；三类失败各给各的提示（413 / 400 非法 JSON / 400 不是对象）；面板加前置体量检查。
- 补「请求中途断掉的导入不会带崩服务」等 10 个回归用例。

## [0.9.4] - 2026-10-21

- **嵌入向量维度成为硬约束**：库中向量与当前模型维度不一致时，写入与相似度比较都直接拒绝并报 `EMBEDDER_DIMENSION_MISMATCH`（说清两边各是多少维），而不是逐维截断后给出一个像样的相似度。
- 嵌入器可配置：本地模型与池化可选，支持 OpenAI 兼容远程端点（`apiKeyEnv` 从环境变量读，插件不落密钥）。
- Jev 裁决改为**运行时解析**：provider 与模型取自 DSH，插件不保存密钥与地址；旧格式字段一次性告警。

## [0.9.3] - 2026-10-20

- **新增 `engram_import` 记忆导入**（#33）：JSON 回路 + 预览勾选 + 内容去重 + 就地补嵌入；导入独立成前置图标按钮，格式支持 JSON 与导出的 Markdown。
- 面板导出菜单项补 button 样式重置（此前镜像目录与导入菜单项渲染成大盒子）。

## [0.9.2] - 2026-10-19

- 镜像导出改 fetch + toast，修复点击崩溃；导入改同款下拉（显式 JSON / Markdown 两项）。
- 会话压缩后重新注入常驻画像（#32）。
- hero 图引用指向 `hero.jpg`（此前引用了已删除的 png）；移除被替换的 `hero.png`，仓库瘦身 2.1 MB。

## [0.9.1] - 2026-10-18

- 翻新清单满宽铺开 + 弹窗不透明兜底（#19 问题一/二）。
- `stats` 分部补上 `shared`。

## [0.9.0] - 2026-10-18

**稳定性与可审计批次（据 [审计报告](../docs/audit-2026-10-18.md)）**

- 视图级 ErrorBoundary（按视图降级 + 重试按钮）——把整类白屏从「不可见事故」变成「可见警告」。
- 失败不再伪装成空态；修搜索框 trim 过早。
- 版本握手 + `VERSION` 单一来源化；客户端与服务端版本偏斜时顶部出现重启提醒横幅。
- 摄取重放循环逐键隔离 + 陈旧放弃 + 已付费的 LLM 产物不静默丢弃。
- 数据安全三连：restore 后关闭并失效分库缓存、SQLite 开 WAL / busy_timeout、迁移前自动快照。
- i18n：翻新理由跟随面板语言、降级墓志铭走词典、俄语复数。

## [0.8.16] - 2026-10-18

- dependabot 接入（npm 每周 / actions 每月）+ `packageManager` 钉 `pnpm@10.15.0`；新增 CONTRIBUTING 与 SECURITY。

## [0.8.15] - 2026-10-18

- #19 修复：翻新清单卡片内联原文与合并候选；侧栏图标回归宿主单色。
- 打包修复：host peers 全部 optional，tarball 能装进干净 profile（0.8.0–0.8.14 十五个版本带病发布的事故收口）。
- CI 门禁：在托管 runner 上真实执行两道不依赖 harness 树的自检。

## [0.8.14] - 2026-10-17

## [0.8.13] - 2026-10-17

- 吸顶 Header/Tab 栏；修复 tab 栏 1px 滚动条；调整 scope 顺序。

## [0.8.12] - 2026-10-15

- 历史回填「卡住」修复：逐轮进度 + 轮询失败显形 + 重启哨兵。

## [0.8.0] - 2026-10-13

- **面板入口升级为顶层侧栏**（`sidebar.panellist` + `main` 双槽位），主列满宽渲染，不再受设置弹窗宽度限制。
- 新增第九视图「信念」与 UI 布局重构。
- 关系图模式补完；侧栏图标改品牌渐变 tile；活动热力日历；走廊真·建筑平面图。

## [0.7.16] - 2026-10-13

## [0.7.15] - 2026-10-03

- 面板第九视图「信念」落地；UI 砍 Header 品牌区、加暖色渐变水印与线性图标。

## [0.7.14] - 2026-10-03

- **自动信念巩固**（`reflect: suggest|auto` + observations 表，schema v12）：把「尚未成为任何信念证据」的原始记忆交给辅助 LLM 巩固为带证据数的一句话信念；同主题经向量近邻自动归并并持续细化；新证据与既有信念近邻时信念先转 `stale`，下次巩固四选一（form / refine / still / refute）。原始记忆全部保留，信念是叠加的抽象层。

## [0.7.13] - 2026-09-25

- 采用 v4 producer-owned plugin message sources。

## [0.7.12] - 2026-09-22

- **Jev 系统一裁决**：DEFER 模糊带的三路判定（并入 / 放行 / 搁置）与矛盾边确认可交外部 Jev 模型判决；Jev 不可用时静默回落纯规则四态，不阻断写入。每次裁决旁路留观测（判定结果、是否参与、耗时、回落原因），面板「裁决」视图可排查。

## [0.7.11] - 2026-09-21

- **实体词典与时序事实链**（阶段三）：事实级三元组携带 `valid_at` / `invalid_at` 时间窗，冲突事实软失效不删除；`engram_facts` 读写事实链；`engram_search` 加 `asOf` 时点回看；面板实体页事实链详情。

## [0.7.10] - 2026-09-21

- 实体词典：摄取与保存的辅助 LLM 输出同时抽取实体提及（人物 / 项目 / 工具 / 概念，可带别名），按归一化名与既有实体精确匹配消解；记忆与实体多对多关联。

## [0.7.9] - 2026-09-21

- **阶段二记忆分层首批**：画像可编辑（`engram_profile_edit`，版本链回滚 + 面板 diff 审计）、episode 情景记忆独立时间线（`engram_episode_timeline`，按会话分组、时间邻近扩展）、回填与实时会话摘要组头。

## [0.7.8] - 2026-09-21

- **阶段一飞轮闭环补强四项全部落地**：写入四态回报（ACCEPT / MERGE / DROP / DEFER）、分级递减注入预算、PII 脱敏扩充（中文密码 / 身份证 / 手机号）、证据门收尾提醒。

## [0.7.7] - 2026-09-21

- 今日待回忆降级为速览计数；陈展加「今日到期」筛选。
- 遗留库迁移治理：写入 JSON 墓碑 sidecar 记录归属，`legacyMigration` 支持 `eager` / `conservative` 两种策略。

## [0.7.6] - 2026-09-17

- 摄取逐条判宫殿（跨项目通用的进私人库，只跟当前项目有关的进项目库）；项目宫殿随 GUI 工作区切换。
- 适配新版 dsh 的 `sessionPersistence` 只读句柄。
- 无 git 时的分库命名从「cwd 前 12 字符」改为 cwd 全量 sha256（修掉同前缀目录撞库）。

## [0.7.5] - 2026-09-12

- CJK token 估算；**证据门 `engram_assess`**（命中 ≠ 足以回答，代码强制三条件齐备）；管家日志补词典。

## [0.7.4] - 2026-09-11

- 面板细节打磨：今日视图重排、工具栏 chips、日志工具条与类别色点、回填分段线。

## [0.7.3] - 2026-09-11

- **历史会话回填**：把 dsh 已持久化的历史会话逐轮提炼进宫殿（默认按每个会话自己的 cwd 分库），幂等键支持中断续跑；导入规则可配（时间窗 / 轮数上限 / 辅助模型 / 是否含子代理）。面板五视图重构。

## [0.7.2] - 2026-09-11

- **记忆宫殿信息架构落地**：位置当索引（写入按 kind 分房并钉「房间#桩位」坐标，房间容量 9，满员开新房）、固定路线定顺序（`tour_routes` append-only）、骨架长期复用、标记独一无二（门牌 0-1 评分）；修复迁移与 dispose 崩溃。

## [0.7.1] - 2026-09-11

- UI 打磨与修复；上架 dsh-market「AGI 架构探索」类目。

## [0.6.1] - 2026-09-01

- 统计卡片补脱敏指标；`engram_export` 脱敏视图。

## [0.6.0] - 2026-09-01

- **注入防护三件套**（协议标签 + 入库脱敏 + 召回占位防回声室）；多查询 RRF 融合；批量保存；脱敏筛选视图。

## [0.5.0] - 2026-09-04

- 竞品对标四项；管理 UI 全面翻新。

## [0.4.7] - 2026-09-02

- 发布时通过 `prepare` 链接 peer 包。

## [0.4.4] - 2026-09-01

- zh/en i18n 走宿主 locale 服务，面板文案全部本地化。

## [0.4.0] - 2026-09-01

- 设置页「记忆库」tab 取代独立页面。

## [0.3.0] - 2026-09-01

- Web 管理面板（`/engram`）+ `/api/engram/*` 回环 API；嵌入回填脚本（为降级期写入的记忆补算向量）。

## [0.2.0] - 2026-09-01

- 自动摄取、矛盾候选、蒸馏飞轮、审计工具；schema v2 记来源会话/轮次/seq、review/stats/export/decay。

## [0.0.1] - 2026-09-01

- 首个可用版本：`engram_*` 工具集、插件入口、画像注入、SQLite + FTS5 + 关系边 + op log 的本地存储。

[Unreleased]: https://github.com/kenz1117/dsh-engram/compare/v0.9.8...HEAD
[0.9.8]: https://github.com/kenz1117/dsh-engram/compare/v0.9.7...v0.9.8
[0.9.7]: https://github.com/kenz1117/dsh-engram/compare/v0.9.6...v0.9.7
[0.9.6]: https://github.com/kenz1117/dsh-engram/compare/v0.9.5...v0.9.6
[0.9.5]: https://github.com/kenz1117/dsh-engram/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/kenz1117/dsh-engram/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/kenz1117/dsh-engram/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/kenz1117/dsh-engram/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/kenz1117/dsh-engram/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/kenz1117/dsh-engram/compare/v0.8.16...v0.9.0
[0.8.16]: https://github.com/kenz1117/dsh-engram/compare/v0.8.15...v0.8.16
[0.8.15]: https://github.com/kenz1117/dsh-engram/compare/v0.8.14...v0.8.15
[0.8.14]: https://github.com/kenz1117/dsh-engram/compare/v0.8.13...v0.8.14
[0.8.13]: https://github.com/kenz1117/dsh-engram/compare/v0.8.12...v0.8.13
[0.8.12]: https://github.com/kenz1117/dsh-engram/compare/v0.7.16...v0.8.12
[0.8.0]: https://github.com/kenz1117/dsh-engram/compare/v0.7.16...v0.8.0
[0.7.16]: https://github.com/kenz1117/dsh-engram/compare/v0.7.15...v0.7.16
[0.7.15]: https://github.com/kenz1117/dsh-engram/compare/v0.7.14...v0.7.15
[0.7.14]: https://github.com/kenz1117/dsh-engram/compare/v0.7.13...v0.7.14
[0.7.13]: https://github.com/kenz1117/dsh-engram/compare/v0.7.12...v0.7.13
[0.7.12]: https://github.com/kenz1117/dsh-engram/compare/v0.7.11...v0.7.12
[0.7.11]: https://github.com/kenz1117/dsh-engram/compare/v0.7.10...v0.7.11
[0.7.10]: https://github.com/kenz1117/dsh-engram/compare/v0.7.9...v0.7.10
[0.7.9]: https://github.com/kenz1117/dsh-engram/compare/v0.7.8...v0.7.9
[0.7.8]: https://github.com/kenz1117/dsh-engram/compare/v0.7.7...v0.7.8
[0.7.7]: https://github.com/kenz1117/dsh-engram/compare/v0.7.6...v0.7.7
[0.7.6]: https://github.com/kenz1117/dsh-engram/compare/v0.7.5...v0.7.6
[0.7.5]: https://github.com/kenz1117/dsh-engram/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/kenz1117/dsh-engram/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/kenz1117/dsh-engram/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/kenz1117/dsh-engram/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/kenz1117/dsh-engram/compare/v0.6.1...v0.7.1
[0.6.1]: https://github.com/kenz1117/dsh-engram/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/kenz1117/dsh-engram/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/kenz1117/dsh-engram/compare/v0.4.7...v0.5.0
[0.4.7]: https://github.com/kenz1117/dsh-engram/compare/v0.4.6...v0.4.7
[0.4.4]: https://github.com/kenz1117/dsh-engram/compare/v0.4.3...v0.4.4
[0.4.0]: https://github.com/kenz1117/dsh-engram/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/kenz1117/dsh-engram/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kenz1117/dsh-engram/compare/v0.0.1...v0.2.0
[0.0.1]: https://github.com/kenz1117/dsh-engram/releases/tag/v0.0.1
