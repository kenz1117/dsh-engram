<div align="center">

# dsh-engram · 记忆宫殿

<p align="center">DeepSeek Harness 跨会话长期记忆插件 — 把记忆宫殿的<b>信息架构</b>（而不是它的神经科学隐喻）真正落进 agent：<b>位置当索引</b>（每条记忆钉在「房间#桩位」坐标上）、<b>固定路线定顺序</b>（巡游路线只增不改）、<b>骨架长期复用</b>（同主题永远同房同序）、<b>标记独一无二</b>（门牌纪律：唯一 · 差异化 · 带日期）。配套间隔重复的检索练习（只给线索、不给正文）与知识飞轮（摄取 → 强化 → 蒸馏 → 衰减）。纯 TypeScript，零外部进程、零 Python 依赖。</p>

<p align="center">
  <a href="https://github.com/kenz1117/dsh-engram/blob/main/LICENSE"><img alt="GitHub license" src="https://img.shields.io/github/license/kenz1117/dsh-engram"></a>
  <a href="https://github.com/kenz1117/dsh-engram"><img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/kenz1117/dsh-engram"></a>
  <a href="https://www.npmjs.com/package/@kenz1117/dsh-engram"><img alt="npm version" src="https://img.shields.io/npm/v/@kenz1117/dsh-engram"></a>
  <a href="https://www.npmjs.com/package/@kenz1117/dsh-engram"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@kenz1117/dsh-engram"></a>
  <a href="https://github.com/kenz1117/dsh-engram/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/kenz1117/dsh-engram"></a>
  <a href="https://github.com/kenz1117/dsh-engram/graphs/contributors"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors/kenz1117/dsh-engram"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

中文 | [English](README.en.md)

</div>

---

## 快速开始

```sh
dsh plugin --profile web add @kenz1117/dsh-engram
```

安装后无需配置即可使用（默认分库与模型缓存在 `~/.dsh/engram`，画像注入开启，自动摄取关闭）。

## 宫殿结构：目录即房间，路径即路线

记忆宫殿真正管用的是它的**信息架构**，不是那套生物学机制——前者机器完全能用，后者 AI 既没有也不需要。拆开看只有四件事：

```
主厅 · 常驻核心记忆   少而稳，每次都在场            每轮注入的画像（条数 + token 预算双限）
  │
走廊 · 路由索引       先决定进哪个房间，别一上来全库检索   房间目录 + engram_search room=
  │
  ├─ 事实厅   fact        用户说过的事实
  ├─ 偏好阁   preference  偏好与口味
  ├─ 决策堂   decision    决策与约定
  ├─ 往事廊   episode     经历与时间线
  └─ 技法坊   skill       方法与技法                 每房容量 9，满员开「房名-2」
  │
门牌 · 铭牌纪律       唯一 · 差异化 · 带日期         写入即评分，低分进翻新清单
```

| 宫殿原则 | 在插件里是什么 | 代码 |
|---|---|---|
| 位置当索引 | 写入即排桩 `房间#桩位`；房间容量 9（7±2），满员开新房，桩位只增不回收 | [src/palace/slots.ts](src/palace/slots.ts) |
| 固定路线定顺序 | `tour_routes` 只增不改；`engram_tour mode=fixed` 按桩位顺序走全宫 | [src/store/sqlite.ts](src/store/sqlite.ts) |
| 骨架长期复用 | 同主题永远落在同一房间同一序号，召回靠顺序提取而非重新检索 | [src/palace/slots.ts](src/palace/slots.ts) |
| 标记独一无二 | 门牌 0-1 评分：全库唯一 +0.4 / 日期锚点 +0.3 / 同房前 6 字不重复 +0.3 | [src/imagery/score.ts](src/imagery/score.ts) |
| 复习纪律 | SM-2 间隔重复；检索练习只给坐标与门牌、**不给正文** | [src/review/sm2.ts](src/review/sm2.ts) |

感官与情绪维度（气味、温度、情绪权重）刻意不计分：那是给人脑先天限制打的补丁，AI 既没有也不需要。

## 特性

- **跨会话记忆**：会话开始注入用户画像摘要（条数 + token 预算双重上限，可配），Agent 天然"记得"你是谁、在做什么；工具检索跨会话召回历史事实。
- **双层分库**：`user.db` 全局共享；`project-<hash>.db` 按 git origin 标识隔离（无 git 时回退 cwd 全量哈希，旧命名库自动迁移）——个人偏好跟人走，项目约定跟仓库走。**项目宫殿随工作区切换**：管理面板「项目」scope 默认跟随 GUI 当前选中的工作区（Header 显示工作区标题与路径），也可在下拉里固定到某个工作区；`engram_save/search` 等工具的 project 读写同样按当前会话 cwd 归属，与面板同一口径。
- **混合检索**：FTS5（unicode61 + 中文 2-gram 预切词）与本地向量（`Xenova/bge-small-zh-v1.5`，512 维，q8）RRF 融合 + 关系边一跳扩展 + 新鲜度/命中次数乘性排序 boost；嵌入模型离线运行，下载失败自动降级纯关键词并显式标记。
- **记忆宫殿信息架构**（v0.7.2+）：四原则全部落进核心路径，而非展示层皮肤——**位置当索引**（写入按 kind 分房并钉「房间#桩位」坐标，房间容量 9，满员开新房，桩位只增不回收）；**固定路线定顺序**（`tour_routes` append-only，`engram_tour mode=fixed` 按桩位顺序走全宫）；**骨架长期复用**（同一 topic 永远落在同一房间同一序号，顺序提取而非重新检索）；**标记独一无二**（门牌规则 0-1 评分：全库唯一 +0.4 / 带日期锚点 +0.3 / 同房前 6 字不重复 +0.3，低分进翻新清单；库内 active 记忆少于 8 条时不扫描，避免小库噪声）。
- **走廊路由检索**：画像里附房间目录，`engram_search` 支持 `room` 参数——先决定进哪个房间，再在房内检索，而非一上来全库 RRF。检索命中 top5 附同房间相邻桩位 id 作为编码特异性线索。
- **检索练习闭环**（间隔重复）：`engram_review_queue` 只给宫殿坐标与门牌线索、**不给正文**，迫使模型先主动回忆；`engram_review` 揭示核对，`engram_report grade`（0-5）自评推进 SM-2 调度（1 → 6 → round(prev × ease) 天，失败重置，ease 下限 1.3）。进入复习调度的条目**不再参与自动衰减**——命运由回忆结果决定。会话开始注入会提示今日待回忆条数。
- **历史会话回填**（v0.7.3+）：把 dsh 已持久化的历史会话逐轮提炼进宫殿——默认按**每个会话自己的 cwd** 写进对应项目库（不串库），同样逐条判作用域（跨项目通用的个人偏好落私人库），复用实时摄取的节流/脱敏/防回声，靠 (会话, 轮次) 幂等键支持中断续跑（键固定在私人库，与实时路径共用）；回填条目不进今日复习队列（避免一次性回填淹没「今日待回忆」）。**导入规则由你选**（时间窗 / 单会话轮数 / 总轮数上限 / 辅助模型 / 是否含子代理·种子·无 cwd 会话），先估算（零成本、不调 LLM）再执行；设置页有独立的**「历史回填」tab**，可看进度（含**跳过原因分布**）与暂停续做。辅助调用默认**复用你当前在用的模型**（历史日志里记的是当年的 provider/model，在当前环境可能已不可用），也可在面板「辅助模型」下拉里从宿主已注册的 provider/model 中直接指定。
- **知识飞轮**：摄取/保存 → 矛盾候选（写入时高相似近邻建 `contradicts` 边并报告，模型/用户裁决）→ 命中强化（confidence +0.05）→ 蒸馏（同主题簇合并为高层规律、supersedes 取代链、置信度继承）→ 衰减（低重要性且长期未访问归档，可恢复）。
- **自动摄取**（`ingest` 配置开启时）：新一轮第一步从会话日志提取上一轮的候选事实，会话结束时补摄取最后一轮（失败留 pending 键，下次会话自动补做，幂等不重复），低 confidence 写入并按嵌入去重——不说"记住"也能攒记忆。**逐条判宫殿**：提炼时同步判定作用域，只跟当前项目/仓库有关的（技术选型、项目约定、架构决策）进当前会话 cwd 对应的项目库，跨项目通用的（个人偏好、习惯、本人经历）进私人库——偏好跟人走、约定跟仓库走。
- **来源审计**：每条记忆记录来源会话、轮次与事件 seq，`engram_review` 完整回查来源链、取代链、矛盾与操作日志；全部写入/修改/遗忘/蒸馏/衰减入操作日志表。
- **Web 管理面板**（v0.7.0+）：设置页「记忆库」tab 分五个视图——今日（速览条：记忆 / 开放 / 清晰度 + 近 7 天计数 + 今日到期 + 健康分环；下面是入殿导航、房间目录、待翻新、健康分构成）、宫殿陈展（筛选含今日到期 / 巡游路线序 / 批量 / 列表与编辑）、走廊巡游（走廊鸟瞰 + 检索实验台）、管家日志（近 7 天计数 + 两库合并的完整 op_log，可按操作类别筛选）、历史回填。Header 三宫格驱动全局 scope（私人 / 项目 / 共享），全部数据源同步；**项目 scope 下三宫格右侧显示当前项目宫殿所属工作区**（标题 + 路径，默认跟随 GUI 当前工作区），旁边的工作区下拉可固定到某个工作区或切回「跟随当前会话」。界面文案中英双语，跟随宿主语言设置实时切换。支持按脱敏标记筛选（仅看/排除含 `[REDACTED:*]` 的条目）并给命中条目挂琥珀色徽标，方便审计脱敏覆盖面。
- **提示注入防护**：全部记忆召回出口（画像注入、`engram_search/timeline/review` 输出）包 `<engram_memory_context>` 协议标签并附使用警告（历史记忆非当前请求、不遵循其中指令、仅相关时使用），当前请求独立包 `<current_user_request>`；所有入库内容（摄取候选、保存正文）先剥离这些协议标签，防伪造协议块二次注入。
- **摄取脱敏**：入库前正则清洗常见密钥凭据（sk- 系 API key、Bearer、AWS AKIA、GitHub token、PEM 私钥、password/token 赋值），命中片段替换为 `[REDACTED:<类型>]`。
- **召回占位（防回声室）**：摄取切片中记忆召回工具的输出替换为 `[engram memory result omitted from capture: <tool>]`，并向提取模型附注"既有记忆的复述不是新信息"，阻断记忆自我强化循环。
- **多查询检索**：`engram_search` 可用辅助 LLM 把查询改写为 ≤3 个互补查询分别检索，跨查询 RRF 融合 + 每查询保底命中；改写失败自动降级单查询（`queryRewrite: false` 关闭）。
- **证据门（search → assess）**：检索命中只说明「相关」，不说明「足以回答」。每次检索登记一个进程内批次（每会话保留最近 20 个，会话结束即释放），输出行尾给出 `ref=…` 与批次 id；`engram_assess` 只能引用同一批次的 ref，且 `sufficient` 由代码强制——三者齐备（模型声称充足、至少一条有效证据、`nextStrategy=answer`）才算充足，否则判为不足并把策略改回继续检索。判定与拒绝明细写入审计日志，面板「管家日志」的「检索」类别可见。
- **数据可携带**：`engram_export` 一键导出 Markdown / JSON 文件，支持脱敏视图（内容二次清洗 + 预览截断，分享安全）。`engram_mirror` 导出可漫游的镜像目录（Obsidian / Logseq 友好：每条记忆一个 Markdown，正文 + YAML frontmatter + 双向链接 `[[id]]`），让「宫殿」也成为可人读的私人知识库。
- **认知架构探索（dsh-market · AGI 架构探索）**：本仓库是 dsh-market「AGI 架构探索」类目下，对 agent 长期记忆的认知科学方法论重构——记忆宫殿（意象标签 + 房间铭牌）、走廊拓扑（力导向图）、闭环提问（摄入时让模型主动追问用户细节）、巩固合并（启发式去重 + 余弦相似度），与 MemGPT/Letta 同层「agent 记忆架构」叙事。

## 工具（17 个，窄参数）

| 工具 | 作用 |
|---|---|
| `engram_save` | 保存（嵌入可用时自动做矛盾候选检测）；支持 `items` 数组单次批量保存 ≤10 条，统一清洗/批量内去重，单条失败不影响其余（`count`/`items`/`failed` 汇总返回）；`placard` 挂门牌（按唯一·差异化·带日期评分，低分附改写建议）。`scope=project` 落当前会话 cwd 对应的项目宫殿 |
| `engram_search` | 语义 + 关键词混合检索（命中强化置信度）；`room` 参数做走廊路由——只在指定房间内检索；命中 top5 附同房相邻桩位线索。输出行尾给 `id=` 与 `ref=`，末尾给批次 id。`scope=project` 查当前会话 cwd 对应的项目宫殿 |
| `engram_assess` | 证据门：作答前判定「检索到的内容是否足以回答」。提交 `batchId` + ≤8 条 `evidenceRefs`（只能取该批次输出里的 `ref=`）+ `missing` + `nextStrategy`；代码强制 `sufficient` 需同时满足「声称充足」「至少一条属于本批次的有效证据」「nextStrategy=answer」，否则判为不足并把策略改回继续检索；非本批次的 ref 会被拒绝并列出，判定写入审计日志 |
| `engram_timeline` | 时间线浏览：默认按创建时间倒序；`order: 'tour'` 改按固定巡游路线桩位顺序（输出附宫殿坐标，未上路线者排末尾），让 agent 也能沿固定路线复述 |
| `engram_update` | 修正（supersedes 取代链）；可同时改挂 `placard` 门牌 |
| `engram_forget` | 遗忘（软删可恢复） |
| `engram_report` | 回报使用效果（skill 类首选）：success 提权 +0.05 / failure 降权 -0.1，持续无效的记忆被衰减自然淘汰。传 `grade`（0-5）则按 SM-2 推进复习调度，作为检索练习的自评入口 |
| `engram_review_queue` | 今日待回忆队列：只给宫殿坐标（房间#桩位）、门牌与逾期天数，**不给正文**——先回忆、再揭示、后自评 |
| `engram_review` | 审计单条：来源链、取代链、矛盾、操作日志 |
| `engram_stats` | 全库统计与信噪比；附房间目录（各房占用桩位与最新门牌） |
| `engram_examine` | 渐进式披露：按 id 批量拉完整铭牌（建议 ≤16 个，先检索拿 id 再取全文） |
| `engram_neighbors` | 走廊漫步：从一间出发走 1-3 跳关系边，返回邻居简表 |
| `engram_tour` | 巡游路由：`mode=fixed` 按固定桩位路线走全宫（路线恒定，顺序提取）；`mode=thematic` 按主题动态规划 3-7 站 |
| `engram_audit_forgotten` | 闭馆考古：列最近已闭馆条目与墓志铭，复核过去的遗忘是否得当 |
| `engram_ingest_history` | 历史会话回填：把 dsh 历史会话逐轮提炼进宫殿（按会话 cwd 分库、已摄取轮次自动跳过）。`dryRun` 缺省 true 只估算；`dryRun=false` 才执行。大批量建议用设置页「历史回填」tab |
| `engram_export` | 导出 Markdown / JSON 文件（数据可携带）；`redactedView: true` 输出脱敏视图（二次清洗 + 40 字预览截断，可安全分享） |
| `engram_distill` | 蒸馏：同主题簇合并为高层规律（LLM） |

## 配置

可选配置（cordis.yml）：

```yaml
- id: dsh-engram
  name: '@kenz1117/dsh-engram'
  config:
    dbDir: '~/.dsh/engram'          # 分库与模型缓存根目录
    injectProfile: true             # 会话开始注入用户画像摘要
    profileTopN: 8                  # 注入条数上限（1-64）
    injectTokenBudget: 1024         # 注入 token 预算（128-8192，中文按 1.5 token/字、其余按 4 字符/token 估算，超预算条目降级为索引行）
    modelCacheDir: '~/.dsh/engram/models'  # 嵌入模型缓存目录
    hfEndpoint: 'https://huggingface.co'   # 模型下载端点，网络受限可配镜像
    ingest: 'off'                   # 自动摄取：off | light（仅用户消息，每轮≤2条）| eager（含助手消息，每轮≤5条）
    # provider 与 model 必须成对提供：摄取/蒸馏的辅助 LLM 路由覆盖（缺省从会话日志解析）
    # provider: 'deepseek'
    # model: 'deepseek-v4-flash'
    decayAfterDays: 30              # 衰减：最近访问超过该天数（同时是检索 recency boost 的衰减窗口）
    decayImportanceBelow: 0.3       # 衰减：且 importance 低于该值 → 归档（可恢复）
    rankRecencyWeight: 0.2          # 检索排序新鲜度因子权重（0-2，0 关闭）
    rankProofWeight: 0.1            # 检索排序命中次数因子权重（0-2，0 关闭）
    queryRewrite: true              # engram_search 用辅助 LLM 改写 ≤3 个查询做 RRF 融合（失败自动降级单查询）
    autoSlot: true                  # 写入期自动排桩（按 kind 分房、钉「房间#桩位」坐标、登记巡游路线）
    reviewScheduling: true          # 写入期自动排入复习调度（1 天后首次到期；关则新条目不进 SM-2 队列）
    # 历史回填默认规则（面板/工具的初始值；总轮数上限是硬顶，按次只能调低）
    historyBackfillDays: 7                  # 默认时间窗天数，0 = 不限
    historyBackfillMaxTurnsPerSession: 20   # 单个会话默认最多摄取轮数
    historyBackfillMaxTotalTurns: 200       # 单次运行的总轮数硬上限（1-5000）
    historyBackfillIncludeSubagents: false  # 默认排除子代理会话
    historyBackfillIncludeSeeded: false     # 默认排除种子会话
    historyBackfillIncludeNoCwd: false      # 默认排除无 cwd 会话（这类只能进 user 库）
```

## 工作原理

插件由宿主半（Node）与浏览器半（React）组成：

```
会话 Agent                                 宿主半（Node）
  │                                          │
  ├─ 每轮第一步 ◀─────────────────────────── ├─ 用户画像快照注入（plugin 来源 user 快照）
  ├─ engram_save / search / review … ──────▶ ├─ SQLite 双库（user.db / project-<origin hash>.db）
  │                                          ├─ FTS5 关键词道 + 本地向量道 RRF 融合 + 排序 boost
  ├─ engram_distill ───────────────────────▶ ├─ 辅助 LLM 蒸馏（簇合并 → supersedes 链）
  │                                          └─ 自动摄取：会话日志 → 候选事实（含会话结束的末轮，ingest 开启时）
  └─ 设置页「记忆库」tab ◀────────────────── ─── 回环 API /api/engram/*（写操作校验回环 Origin）
```

- **双层分库**：`user.db` 全局共享；`project-<hash>.db` 按 git origin URL 归一化哈希命名（`git@github.com:a/b.git` 与 `https://github.com/a/b` 同库；worktree 沿指针解析到主仓库 origin）；无 git 或无 origin 时按 **cwd 全量 sha256** 命名（v0.7.6 起；旧的「cwd 前 12 字符」截断命名会同前缀撞库，启动时自动 rename 迁移，新旧并存则不动并告警）。
- **项目宫殿路由**：`GET /api/engram/workspaces` 给出可选项目宫殿清单（来源 = 宿主 `workspaceRegistry` 工作区 → 会话 header 里出现过的 cwd → 插件进程目录兜底，按分库名去重；同仓库的多个 worktree 共用一个宫殿）；所有项目 scope 的接口与工具读写接受选择器（HTTP `?project=<dbName>` / POST body `project`，工具用当前会话 `session.header.cwd`），未知选择器 HTTP 回 404、工具回退进程目录。面板「项目」scope 默认跟随 GUI 当前工作区并可固定到某个工作区。
- **宫殿结构（目录即房间，路径即路线）**：**主厅** = 每轮注入的常驻核心画像（少而稳，每次都在场）；**走廊** = 画像里附的房间目录 + `engram_search room` 参数（先定房间，再检索）；**房间** = 按 kind 分房（事实厅 / 偏好阁 / 决策堂 / 往事廊 / 技法坊），容量 9，满员开「房名-2」；**门牌** = 每条记忆的 `placard` 铭牌，受唯一·差异化·带日期纪律评分。存量库首次打开时自动补排桩（幂等，开新房会告警提醒人工命名）。
- **自动摄取**（`ingest` 开启时）：新一轮第一步从会话日志提取上一轮的候选事实；会话结束（session/disposed）补摄取最后一轮，5 秒超时，失败/超时把 pending 键写入操作日志，下次会话首步自动重放补做；已摄取的 (会话, 轮次) 幂等去重（键固定在私人库，实时与历史回填共用一份，跨路径不重复）。读取源是会话日志；辅助调用的请求审计走插件自身操作日志，不向会话日志 append 未知事件。候选以低 confidence 写入并按**目标分库内**的嵌入近邻去重。**作用域逐条判**：提炼输出带 `scope`，`project` 落当前会话 cwd 的项目库、`user` 落私人库；无 cwd 的会话只能进私人库（此类会话不做逐条判定，避免标记与实际分库不符）。历史回填沿用同一判定，默认按各会话自己的 cwd 落项目库。
- **来源链**：每条记忆记录来源会话、轮次与事件 seq，`engram_review` 可完整回查；操作日志表记录全部写入/修改/遗忘/蒸馏/衰减。
- **嵌入离线**：模型首次使用需联网下载（q8 约 50MB，端点可配镜像），此后完全离线；失败时插件照常工作，检索降级纯关键词并显式标记。
- **界面本地化**：client 半经宿主 locale 服务注册 zh/en 词典，跟随宿主语言设置实时切换；状态/种类等数据枚举仅在显示层映射，存储值保持英文。

## Web 管理面板（设置页「记忆库」tab）

宿主带 webServer 的 profile（web 等）会在**设置页**自动出现「记忆库」tab（经 `settings.section` 槽位注册，client 半为 React 组件、随 `lib/client.js` 由宿主模块表装载）：统计卡片、按状态/种类/内容过滤、行内详情与编辑（走取代链）、遗忘/恢复、导出 Markdown/JSON 下载。数据经回环 API `/api/engram/*`（写操作校验回环 Origin）。headless 等无 webServer 的组合不挂载，其余能力不受影响。

v0.7.2 起「今日」视图首屏新增**「今日待回忆」卡**：按线索（房间#桩位 · 门牌 · 逾期天数）逐条列出待回忆记忆，点「揭示铭牌」才显示正文，随后以「记得 / 模糊 / 忘了」三档自评（映射 SM-2 grade 5/3/1）推进调度。有待回忆时 Header 出现**红色角标**（显示条数），点击直达该卡；答题后角标自动递减。宫殿陈展列表新增**「按巡游路线」排序**开关，可切到固定桩位顺序浏览，列表行同时显示每条记忆的宫殿坐标。

v0.7.3 起新增独立的**「历史回填」tab**：导入规则全部由你选择（时间窗 / 单会话轮数 / 总轮数上限 / 是否包含子代理·种子·无 cwd 会话），点「重新估算」先看候选会话数与待处理轮数（零成本、不调 LLM），确认后「开始回填」；运行中显示进度（会话 / 轮次 / 写入条数 / 跳过 / 失败）并可随时暂停——已完成的轮次按幂等键跳过，再点开始即续做。同一版把面板重做成五个视图（今日管家 / 宫殿陈展 / 走廊巡游 / 管家日志 / 历史回填）：原常驻的九格「管家日报」条收进「今日」视图的速览卡（三个大指标 + 近 7 天计数 + 健康分环），首页只留在办与参考两块（待回忆、待翻新 / 房间目录、入殿导航）；走廊鸟瞰与检索实验台移入「走廊巡游」；管家日志独立成整页，可按落成类 / 发掘 / 检索 / 整理筛选；五间房各一色（事实蓝 / 偏好紫 / 决策青 / 往事橙 / 技法品红）贯穿标签、房间目录与走廊节点。陈展列表改为紧凑行式：分隔线取代卡片描边、正文两行截断、操作按钮 hover（或键盘聚焦）才显现、窄屏折到正文下方，一屏可读条目约翻一倍。翻新清单在库内 active 少于 8 条时不再扫描，避免小库噪声。

v0.7.4 起继续打磨面板细节：今日视图重排为「左入殿导航 · 右房间目录、今日待回忆、翻新清单」，入殿导航与房间目录加大行间距；宫殿陈展工具栏改「搜索 + 状态 + 排序」一行、房间筛选独立成可换行 chips；管家日志把计数与类别筛选合成一条工具条，并给每行加类别色点（落成 / 发掘 / 检索 / 整理）；历史回填的规则、估算、执行三段改用分隔线切块；区域间距统一由容器间距给出，消除「标题贴住上方卡片、下方却过松」的不对称。

v0.7.5 起是两处底层修正加一层新能力。① 画像注入的 token 估算改为 CJK 感知（中文按 1.5 token/字、其余按 4 字符/token）：此前按长度除以 4 会把中文低估四倍以上，中文用户的实际注入长期超出 `injectTokenBudget` 约 17%–50%；末尾 `+N more` 计数行也纳入预算，注入总量不再超承诺。② 新增**证据门** `engram_assess`（工具 17 个）：检索命中只说明「相关」，不说明「足以回答」；`engram_search` 每次登记一个进程内证据批次（每会话保留最近 20 个，会话结束即释放），输出每行带 `ref=`、末尾带批次 id；`engram_assess` 只能引用同一批次的 ref，且 `sufficient` 由代码强制——声称充足、至少一条有效证据、`nextStrategy=answer` 三者齐备才算充足，否则判为不足并把策略改回继续检索；不属于该批次的 ref 会被拒绝并列出，判定写入审计日志（管家日志「检索」类别可见）。③ 管家日志补齐 op 词典与明细格式化（闭馆整理 / 复习答题 / 排桩 / 批量排桩 / 开新房），不再显示英文原名与原始 JSON。

v0.7.6 起把「作用域」从写死改成逐条判、并让项目宫殿跟着工作区走。① **摄取逐条判宫殿**：提炼时同步判定 `scope`——只跟当前项目/仓库有关的（技术选型、项目约定、架构决策）进该项目库，跨项目通用的（个人偏好、习惯、本人经历）进私人库；实时摄取（上一轮 / 会话结束末轮 / 待补做重放）与历史回填同一口径，回填按**每条会话自己的 cwd** 落库。幂等键（`ingest-done` / `ingest-pending`）固定在私人库，与写入落点解耦，所以实时与回填共用一份 (会话, 轮次) 键、跨路径不重复摄取。② **项目宫殿随工作区切换**：新增 `GET /api/engram/workspaces`（来源 = 宿主工作区注册表 → 会话 header 里出现过的 cwd → 插件进程目录兜底，按分库名去重，同仓库多 worktree 共用一个宫殿），所有项目 scope 的接口接受 `?project=<dbName>` 选择器，未知选择器回 404；`engram_save/search` 等工具的 project 读写改按当前会话 cwd 归属。面板的「项目」作用域在作用域三宫格下方新增一行：**当前工作区 chip + 工作区下拉**（默认「跟随当前工作区」，可临时固定到某个工作区），切工作区即整体切换。③ 无 git 时的项目分库名从「cwd 前 12 字符编码」（同前缀目录会撞库）改为 **cwd 全量 sha256**，旧命名库启动时自动 rename 迁移；插件卸载时关闭所有分库连接（Windows 上不再锁住 .db）。

## 开发

```sh
pnpm install            # postinstall 会把 @deepseek-ai/* peer 从 ../deepseek-harness symlink 进来（需先在 harness 仓库 pnpm install && pnpm run build）
pnpm test               # 单测 + 组合测试；真实嵌入 e2e：ENGRAM_E2E=1（可配 HF_ENDPOINT）且网络可达时执行
pnpm typecheck
pnpm bundle
```

## Model Experience

### Request context and condition

#### What the model sees

会话每轮第一步追加一条 plugin 来源的 user 快照：`User memory profile (dsh-engram, cross-session) — Grand Hall (always present):` 加用户级记忆列表（默认至多 8 条且整段不超过 1024 token 预算，超预算条目降级为 `#id` 索引行，`injectProfile: false` 关闭），行内带宫殿坐标（`房间#桩位`）；有到期复习条目时末尾追加一行提示今日待回忆条数。工具调用结果为纯文本行列表（含 `id=`、scope/kind 标注、桩位坐标、矛盾候选提示与降级说明）。自动摄取与蒸馏各产生一次辅助 LLM 调用（独立于主对话计费路径，带 purpose 归因）。

#### Token effect

画像注入为条件性固定成本（受条数上限与 token 预算双重约束）；工具 schema 为常驻成本（17 个窄参数工具）。

#### KV Cache effect

画像文本随记忆库内容变化——变化只体现在新会话或记忆更新后的轮次边界；同一会话内注入内容不变时前缀保持稳定；工具 schema 恒定，不影响前缀。

## Known Limitations and Deferred Work

- **矛盾候选无 LLM 判定** —— 写入时仅按向量相似度（≥0.88）报告候选并建边，语义矛盾的确认留给模型/用户裁决与蒸馏。
- **嵌入器降级期间的记忆无向量** —— 模型未就绪时写入的记忆不参与语义道；语义上线后跑一次 `pnpm backfill` 补算存量向量（`pnpm build` 的模型缓存就绪后执行，可经 `HF_ENDPOINT` 配镜像）。

## 致谢

感谢社区贡献者让这个项目更好：

- **[@lujfsd](https://github.com/lujfsd)（路杰锋）** —— [PR #2](https://github.com/kenz1117/dsh-engram/pull/2)：适配新版 dsh 的 `sessionPersistence` 只读句柄（新版已移除 `load()`）、摄取逐条判宫殿（提炼输出新增 `scope`）、项目宫殿随工作区切换（`GET /api/engram/workspaces` + 面板工作区选择器），并把无 git 时的分库命名从「cwd 前 12 字符」改为 cwd 全量 sha256（修掉同前缀目录撞库）。随 PR 附 17 条测试与两份设计文档。
- **[@f0909172434](https://github.com/f0909172434)** —— [PR #4](https://github.com/kenz1117/dsh-engram/pull/4)：遗留项目库迁移的归属治理——eager 迁移改名时补写 JSON 墓碑 sidecar（`<旧库名>.migrated-to`，独占创建 + 0o600，记录 `migratedTo` / `claimedByCwd` / `claimedAt`），后续工作区撞上同一旧命名时收到指向先前归属的告警；新增 `legacyMigration` 配置（`eager` 默认自动迁移 / `conservative` 不动旧库只告警），迁移结果细化为 `renamed` / `kept-both` / `deferred` / `already-migrated` 等状态。随 PR 附测试。

## 许可证

[MIT](LICENSE) © 2026 KenZ (kenz1117)

### 旧项目库迁移策略

`legacyMigration: eager`（默认）保留现有自动改名行为：只有旧库存在时迁移，
并写入私有 JSON 记录 `<旧文件名>.migrated-to`，包含 `migratedTo`、
`claimedByCwd` 和 `claimedAt`（ISO 时间）。后续工作区碰到相同的旧命名时，
会收到指出先前归属的告警。记录证明的是文件迁移，**不证明每条记忆的归属**。
相同 origin 的 worktree 仍共用新库。

若需保守升级，在升级／打开旧数据**之前**于插件 `cordis.yml` 配置中设置
`legacyMigration: conservative`。旧库保持原状，告警列出旧名和拟用的新名，
会话继续使用新建的空项目库。无论何种策略，新旧库并存时都不移动或合并。
此选项不能撤销已经发生的迁移。

人工处理前，停止使用该目录的所有宿主，备份数据库和 SQLite sidecar，
通过 `engram_review` / `engram_export` 审核、导出相关记忆。
**新库可能已有新记忆，不要直接用旧库覆盖它**；应审核两边后人工重新归属。
不自动分类、拆分、合并或删除数据。

记录包含本地工作区路径，请作为私有元数据保管。记录损坏或不可读时迁移会报错；
恢复旧库备份后若旁边已有迁移记录，也需人工确认。改名与写记录不是原子事务，
亦不提供跨进程锁；请先停止其他宿主。写记录失败会明确报出旧名和新名，
此时数据库已改名，不自动回滚。若在两步之间崩溃，重试前应检查文件状态。
本功能不会为历史迁移补造记录。
