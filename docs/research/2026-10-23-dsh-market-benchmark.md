# dsh-engram × DSH 插件商店：同类目高星项目调研与改进建议

- 日期：2026-10-23
- 基线：dsh-engram v0.9.8（npm `@kenz1117/dsh-engram`，2026-10-22 发布）
- 商店数据源：`awesome-dsh-plugin.com/catalog.json`（6565 条，2026-10-23 抓取）、`awesome-dsh-plugin/awesome-dsh-plugin` 的 `contributing.md` 与 `data/plugins/*.yml`、npm registry 下载量 API（滚动 30 天窗口 2026-09-19→10-18）
- 竞品数据源：GitHub REST API 元数据、各仓 README 原文、npm registry manifest

---

## 0. 一句话结论

**商店按 npm 下载量排序，所以下载量才是唯一 KPI——而我们的瓶颈是「曝光池子 + 首屏说服力」，不是功能。**

实测数据：

- **下载量不缺**：AGI 类目里排第 3（23 个有下载量的条目中），全站第 170/3,168；移到 Memory 类目是第 15/143——依然体面，说明产品转化没问题。
- **但天花板被池子锁死**：AGI 类目总共 36 条，只有 23 条有下载量；Memory 类目 279 条、143 条有下载量。找「记忆插件」的人不会翻 AGI 区。
- **star 转化偏低**：star/下载 = 0.51%，低于同池的 dsh-memory（1.84%）、mnemon（1.39%）、auto-memory（1.11%）、clearai（13.0%），高于纯靠安装 prompt 拉量的 dsh-pua（0.05%）。**看过 README 就愿意 star 的人不够多**——这是首屏问题。

商店站点的**唯一头条排序键是 npm 30 天下载量**（星数只是并列时的次级排序键），而下载量来自 npm registry 的滚动窗口。所以真正的增长杠杆只有三个：**类目位置正确**、**npm 安装路径多条**、**README 首屏让人愿意装**。

---

## 1. 商店格局实测

### 1.1 类目分布（6565 条）

| 类目 | 条数 | 有 npm 下载量的 | 说明 |
|---|---|---|---|
| ui | 1237 | — | 最大池 |
| tools | 854 | — | |
| session | 465 | — | |
| dev | 431 | — | |
| workflow | 374 | — | |
| model | 355 | — | |
| usage | 346 | — | |
| **memory** | **279** | **143** | **功能同类池** |
| theme / skill / notify | 256 / 250 / 250 | — | |
| fun / remote / security | 200 / 197 / 196 | — | |
| git / browser / vision | 145 / 141 / 137 | — | |
| docs / market / voice | 103 / 97 / 84 | — | |
| wsl / identity | 80 / 52 | — | |
| **agi（我们在的）** | **36** | **23** | **叙事池，赛道窄** |

### 1.2 我们的位置

| 指标 | dsh-engram |
|---|---|
| star / fork / open issue | 31 / 8 / 5 |
| 30 天下载（npm registry） | 7,406 |
| 30 天下载（商店口径） | 6,120 |
| AGI 类目按下载量 | **第 3 / 23** |
| AGI 类目按 star | 第 5 / 36 |
| 移到 Memory 类目后按下载量 | 约 **第 15 / 143** |
| 全站按下载量 / 按 star | 第 170 / 3,168 · 第 435 / 6,556 |
| 下载/星数比 | 197（同 AGI 类目中游；dsh-pua 2018、dsh-memory 54、clearai 8） |
| star/下载 转化率 | **0.51%**（dsh-memory 1.84%、mnemon 1.39%、auto-memory 1.11%、clearai 13.0%、dsh-pua 0.05%） |
| npm 版本数 | 42 个（2026-09-01 起 7 周） |

### 1.3 同类目（AGI）高星项目

| 项目 | star | 30 天下载 | 核心叙事 | 工程量 |
|---|---|---|---|---|
| Clearailhc/clearai-dsh | 665 | 5,104 | 「Your research, grown into an ontology」6 词定位 + 双主题 hero 图 + 与裸模型的循环对照表 | 29 测试文件 / 2 workflow |
| FuRongJun-1999/dsh-memory | 455 | 24,735 | 五环契约海报（存在/记忆/验证/反思/连接），理念逐环绑定到可验证机制 | 168 测试文件 / 8 workflow |
| MichengAI/dsh-pua | 33 | **66,599** | 11 词定位 + **可复制的「让 agent 自己装」prompt** + 11 个自家插件互相导流 | 24 测试文件 / 2 workflow |
| Kanadego/dsh-heartbeat | 16 | 3,569 | 9 张设置卡截图做成首屏表格 + 术语表 + 直接写「实测漏到 62 个工具」 | 41 测试文件 / 2 workflow |
| **kenz1117/dsh-engram** | **31** | **6,120** | 记忆宫殿 IA（位置当索引 / 固定路线 / 检索练习） | 37 spec / 1 workflow（不含 test 与 typecheck） |

**最直接的竞品是 FuRongJun/dsh-memory**：同在 AGI 类目，同样讲「知识飞轮 + 白箱可审计 + 持续学习」，星数是我们的 14 倍。它的杀手锏是**把理念做成一张海报图 + 一张「承诺→机制」对照表**，再配一个**独立的公开基准仓库**（hive-memory-bench）做横评。

### 1.4 功能同类（Memory 类目）高星项目

| 项目 | star | 30 天下载 | 存储 / 外部依赖 | 涨量机制 |
|---|---|---|---|---|
| vectorize-io/hindsight | 52,796 | 53,906 | PostgreSQL + pgvector，**要 Docker 与 LLM Key** | 论文 + LongMemEval SOTA + 在线 benchmark 站 + 4 段演示视频 |
| omdsh-dev/dsh-mnemon | 653 | 47,007 | 本地 + 9 家第三方 Provider（可选） | **npm 上是 19 包家族**（子包 peer 反指根包，合计 50 万+下载）+ 5 段 GIF + 落地页 mnemon.dev |
| volcengine/OpenViking | 40,609 | 34,787 | **必须有 OpenViking 服务端** | 字节背书 + 30 个 workflow + star-stats 落数 |
| agentscope-ai/ReMe | 3,675 | 1,869 | **必须跑 Python 服务 `reme start`** | 阿里 ModelScope 生态 + 7 张真实截图 + 双语 README |
| zilliztech/memsearch | 2,777 | 2,363 | **必须 Milvus + uv 安装** | Zilliz 背书 + 5 平台矩阵 + ASCII 数据流图 |
| Phant0Meow/dsh-meow-memory | 253 | 9,211 | `node:sqlite`，零依赖零模型 | 最小工程量 + 首屏零图也能到 9k |
| Aik358/dsh-auto-memory | 145 | 13,014 | 纯 Markdown | **34 张 promo 图 + 落地页 + 自带可测量指标（actPrecision 0.917）** |
| csyangwen/dsh-memory-evolve | 426 | **0** | 零依赖 | **反例：没发 npm → downloads 为 null → 直接掉出下载排序** |
| PerryLink/dsh-memento | 138 | 5,474 | SQLite 0600，零网络 | 协议 v1 + conformance suite + **只读 MCP server**（带非 DSH 渠道下载） |

---

## 2. 差距诊断（四层）

### 2.1 曝光层（最大缺口）

1. **类目归错。** 我们 `category: agi`（36 条），5 个功能同类对标全部 `category: memory`（279 条）。找「记忆插件」的人根本不会翻 AGI 区。贡献指南明写：类目选错**不会被打回**，维护者会直接改——所以改类目是零风险动作。
2. **商店条目描述已过期。** 现描述仍写「settings-page Memory Library panel with corridor topology, tour butler, and refurb list」，但 v0.8 起面板已是**顶层侧栏入口、9 个视图**，「tour butler」是旧命名，且完全没提 SM-2 检索练习、信念巩固（observations）、实体词典、Jev 裁决。**描述会被维护者逐条与代码核对**——这既是失分，也是被打回重写的风险。
3. **商店条目没有 `icon` 字段**，回退到作者头像；我们仓库里只有 SVG（`icon.svg` / `icon-256.svg`），商店要的是 **GitHub 托管的 https 位图**（180px PNG 之类）。
4. **GitHub 仓库元数据是空的**：`description` 为 null、`homepage` 为空、topics 只有 8 个且缺 `memory-palace` / `long-term-memory` / `agent-memory` / `rag` / `fts5`，**没有 social preview 图**（星标不会自动生成，得手动传 `social-preview-image`）。
5. **README 首屏没有 6-10 词的英文定位句**、没有 ASCII 数据流总览、没有「我们 vs 别人」的对照表、没有一条可测数字。搜索者搜的是 `memory` / `long-term memory` / `RAG`，不是「宫殿」。

### 2.2 分发层

6. **npm 安装路径只有 1 条。** mnemon 用 19 个包把同一份工作铺成多条安装路径（实测：根包 51,615、strategy-default-three-tier 30,819、provider-hindsight 25,680、provider-mem0 24,223）。子包 manifest 里 `peerDependencies: {"dsh-mnemon": "^0.5.17"}` → npm 7+ 自动装 peer → 装子包必然拉根包，根包计数被放大。**这是被数据验证过的放大器，但也只是把同一份工作多次计数**，不能当作产品价值本身。
7. **没有 MCP server 出口**。memento 发只读 `dsh-memento-mcp`，Claude Code / Codex 可直接 `npx` 装——带来完全独立的 DSH 之外安装路径。我们只在 DSH 内可用。
8. **README 没有「给 agent 的一键安装 prompt」**。dsh-pua 66,599 下载很大程度靠这一段可复制文本。
9. **没有落地页 / 文档站**（三家对标都有独立站），`package.json` 也没有 `homepage`。
10. **生态没有互链**，也没有接 `dsh-find-plugin`（agent 帮用户找插件）、`dsh-market`（商店内一键装）、Discover index source。

### 2.3 工程层

11. **CI 门禁形同虚设**：`checks.yml` 明确**不含 typecheck / test / bundle**，只跑两个文本脚本 + 打包冒烟。对标方是 5-8 个 workflow 跑真实构建与测试。外部贡献者无法在 PR 上看到自证。
12. **零 lint、零 coverage**（我们自己的 `docs/audit-2026-10-18.md` §7 已列 P1，至今未做）。
13. **typecheck 进不了 CI 的根因已核实**：官方 peer 在 npm 上**互相冲突**——实测 `npm install` 报 ERESOLVE（`dsh-invariants` 被同时要求 `^0.1.0-rc.8` 与 `^0.0.1-rc.1`，且 `dsh-type-meta` 未发布）。但我们全仓**只有 4 个值导入**符号（`defineTool`、`BlockAssembler`、`createUserMessage` ×2、`schemastery` 的 `z`），其中 `schemastery` 已在 npm。**做一份 4 符号的类型快照即可解锁 typecheck 入 CI**（我们自己的审计提出过 `export-peer-types.mjs` 方案，尚未落地）。
14. **没有 CHANGELOG**，发布叙事全靠 GitHub Releases；42 个 npm 版本里没有一处写「这版修了什么、为什么」的结构化说明（GitHub Release 里其实是有的，但 npm 页面与商店条目看不到）。
15. **Windows 标记**：历史审计指出 3-4 个测试在 Windows 永红且无 `skipIf` 标记，fork 贡献者无法自证。

### 2.4 产品层（差距最小，别在这花力气）

22 个窄参数工具（对标 ReMe 只有 1 个 `reme_search`、memsearch 0 个原生工具）、三语 i18n、双库分库、离线嵌入自动降级、完整审计链——**这些都领先**。真正缺的是三样：

- **没有一个可测数字**。hindsight 有 LongMemEval SOTA，dsh-memory 有 hive-memory-bench 六家横评，auto-memory 有 actPrecision 0.917。我们 README 路线图承诺的「LoCoMo-zh 评测集进 CI 作检索质量回归门」**至今没做**——这是自己许下的诺。
- **没有 memory→skill 产物**。memsearch 把重复工作流蒸馏成 skill 候选（永不自动安装）。我们有「翻新清单」，但没接到 skill 产出。
- **没有 outbox 式幂等队列**。ReMe 的 outbox 落盘 + 递增时间戳 + sealed batch + 指数退避 + 崩溃恢复，比我们「pending 键」完整一档。

### 2.5 我们必须保住并讲出来的差异化

1. **零外部依赖**：对标方要 Docker / Postgres / Milvus / Python 服务 / LLM Key；我们是纯 TypeScript、纯本地 SQLite、离线嵌入、失败自动降级。**装完即用**——这是最硬的差异，却不在 README 第一屏。
2. **证据门 `engram_assess`**：命中 ≠ 足以作答，代码强制「声称充足 + 至少一条本批次有效证据 + nextStrategy=answer」三者齐备。四家对标全都没有这个契约。
3. **间隔重复检索练习（SM-2）**：只给坐标不给正文，强制先回忆后揭示。**没有任何一家做**。
4. **提示注入防护 + 脱敏 + 防回声**：协议标签 + `[REDACTED:*]` + 召回占位，对标方全无。
5. **数据可携带**：`engram_export`（含脱敏视图）+ `engram_mirror`（Obsidian/Logseq 友好镜像）。
6. **完整记忆生命周期**：21 工具覆盖保存/检索/事实链/时间线/审计/导出/蒸馏/信念/复习。

---

## 3. 改进建议（按 ROI 排序）

### P0 · 零开发，本周可完（预计换回最大曝光差）

| # | 动作 | 落点 | 预期 |
|---|---|---|---|
| 1 | **商店类目 `agi` → `memory`**，并按 ReMe/memsearch 的写法重写描述（零依赖 / 混合检索 / 证据门 / 21 工具） | `awesome-dsh-plugin` PR，改 `data/plugins/kenz1117__dsh-engram.yml` | 从 AGI 区 #3 变成 Memory 区约 #15，且出现在真正找记忆插件的人的视野里 |
| 2 | **补商店 `icon` 字段**：把 `icon.svg` 导出 180px PNG 传到仓库（如 `docs/store/icon-180.png`），YAML 里写 `icon: https://raw.githubusercontent.com/kenz1117/dsh-engram/main/docs/store/icon-180.png` | 同上 | 商店卡片用我们的宫殿剪影，不再回退到作者头像 |
| 3 | **GitHub 仓库元数据**：填 `description`（含「Cross-session long-term memory」关键词）、`homepage`（落地页）、补 topics（`memory-palace` `long-term-memory` `agent-memory` `rag` `fts5` `knowledge-graph` `dsh-market`）、**上传 social preview 图** | 仓库 Settings / `package.json` | GitHub 搜索与分享卡片的可发现性 |
| 4 | **README 首屏重构**：加一行 6-10 词英文定位句（例：`Local-first long-term memory for your agent. Zero setup.`）、加 ASCII 数据流图（capture → inject → recall → review 四行）、加「我们 vs 主流记忆插件」对照表（零依赖 / 工具数 / 证据门 / 审计 / 复习） | `README.md` + `README.en.md` | 竞品都有，我们没有；这是 star 转化的第一道闸 |
| 5 | **README 加「给 agent 的安装 prompt」段**：一段可复制文本让 agent 自己执行 `dsh plugin --profile web add @kenz1117/dsh-engram` | `README.md` | dsh-pua 6.6 万下载的直接机制 |
| 6 | **补 CHANGELOG.md**（Keep a Changelog + npm 版本对照） | 仓库根 | npm 页面 / 商店之外的第一信任源 |
| 7 | **README 徽章补齐**：CI 状态、npm 下载曲线、star-history、dsh-market / dsh-find 徽章 | `README.md` | 可发现性入口 |

### P1 · 一到两周，小工程，大回报

| # | 动作 | 落点 | 说明 |
|---|---|---|---|
| 8 | **解锁 CI 的 typecheck**：为 4 个值导入符号做类型快照（`scripts/export-peer-types.mjs`），让 `tsc --noEmit` 在托管 runner 上可跑 | `scripts/`、`.github/workflows/checks.yml` | 我们审计里就写过的方案；解了它，CI 才是真门禁 |
| 9 | **CI 加 lint（typescript-eslint + prettier）与 coverage（v8 + 阈值棘轮）** | 同上 | 对标方 5-8 个 workflow；外部贡献者能在 PR 上自证 |
| 10 | **做出一个可测数字并放进 README 首屏**：跑 LoCoMo-zh 或自建 recall 基准（命中率 / MRR / 注入 token 开销对比），把结果做成表格 | `tests/` + `docs/` | 兑现路线图承诺；hindsight / dsh-memory / auto-memory 都靠这个拿 star |
| 11 | **补 npm 安装路径**：① 发只读 MCP server 包 `@kenz1117/dsh-engram-mcp`，让 Claude Code / Codex 也能装；② 拆 `@kenz1117/dsh-engram-cli`（审计 / 导出 / 备份）；③ 子包 `peerDependencies` 反指根包，让下游安装自动拉根包 | `packages/` | memento 与 mnemon 都验证过：每多一条安装路径，根包就多一轮计数。**但要清楚这是计数放大，产品价值另算** |
| 12 | **落地页 / 文档站**：GitHub Pages 一页（定位、对比表、5 张真实面板截图、30 秒演示 GIF、安装命令） | `docs/site/` | 三家对标都有独立站，我们没有 |
| 13 | **首屏换成录屏**：面板 9 个视图录成 20-30 秒 GIF（用户 issue #34 主动录了视频，说明面板值得看） | `docs/screenshots/` | mnemon 5 段 GIF / auto-memory 34 张 promo |
| 14 | **接 `dsh-find-plugin` + Discover index source + dsh-market 一键装** | README / 商店 | 三个现成流量入口 |

### P2 · 一个季度，产品级

| # | 动作 | 说明 |
|---|---|---|
| 15 | **memory → skill 产物**：把反复出现的工作流蒸馏成 skill 候选（永不自动安装，需人工确认） | memsearch 的做法，接我们的「翻新清单」 |
| 16 | **outbox 幂等队列**：落盘 + 递增时间戳 + sealed batch + 指数退避 + 崩溃后 owner-lock 恢复 | 补齐我们「pending 键」的工程债 |
| 17 | **生态互链**：与同族记忆插件互相链接；把「记忆宫殿 IA」写成可被引用的方法论文章（对标 dsh-memory 的第三方教程外链） | 低成本换外链流量 |
| 18 | **Windows `skipIf` 标记 + 跨平台矩阵 badge** | 解除 fork 贡献者的自证障碍 |

---

## 4. 三个必须避开的坑

1. **别为了刷 star 去改产品。** 我们的安装量在类目里排第 3，说明「找到 → 装上」这一段没漏人；商店又只按下载量排序，star 不影响曝光位次。先修曝光链路（类目 / 安装路径 / 首屏），再谈功能。
2. **别用「记忆宫殿」当第一关键词。** 搜索者搜 `memory` / `long-term memory` / `RAG` / `hindsight`；「宫殿」是我们的叙事资产，应放在第二屏。首屏主张应该是：**零依赖本地记忆层 · 22 个窄参数工具 · 带证据门与审计 · 间隔重复复习**。
3. **注意命名撞车。** 商店里已有 `skepsun/dsh-engram`（memory 类目，7★ / 1,366 下载）。我们用 scoped 包名 `@kenz1117/dsh-engram` 已在安装命令上区分，但建议在 README 与描述里强化「记忆宫殿 / memory palace」这个唯一标识，避免被当成同一项目的分身。

---

## 5. 附录 · 关键实测记录

```
# 商店条目（我们）
url: https://github.com/kenz1117/dsh-engram
name: kenz1117/dsh-engram
category: agi              # ← 建议改 memory
description: ... settings-page Memory Library panel with corridor topology, tour butler, and refurb list.
                        # ↑ 已过期：v0.8 起为顶层侧栏面板 9 视图；「tour butler」是旧命名
# 缺 icon 字段 → 商店卡片回退到作者头像

# npm peer 不可安装的根因（CI 无法跑 typecheck 的原因）
$ npm install @deepseek-ai/{cordis,dsh-agent,dsh-client-ui-layout,dsh-llm,dsh-tools,schemastery}
npm error Could not resolve dependency:
npm error peer @deepseek-ai/dsh-invariants@"^0.1.0-rc.8" from @deepseek-ai/dsh-llm@0.1.0-rc.8
npm error Conflicting peer dependency: @deepseek-ai/dsh-invariants@0.0.1-rc.1
# @deepseek-ai/dsh-type-meta 未发布；schemastery 3.18.5 已发布

# 全仓仅 4 个 peer 值导入（typecheck 快照只需覆盖这些）
src/tools/create.ts  → defineTool            (@deepseek-ai/dsh-tools)
src/llm/client.ts    → BlockAssembler, createUserMessage  (@deepseek-ai/dsh-llm)
src/index.ts         → createUserMessage    (@deepseek-ai/dsh-llm)
src/config.ts        → z                    (@deepseek-ai/schemastery)

# mnemon 的计数放大机制（实测）
dsh-mnemon                              51,615
dsh-mnemon-strategy-default-three-tier  30,819
dsh-mnemon-provider-hindsight           25,680
dsh-mnemon-provider-mem0                24,223
# 子包 manifest: peerDependencies: { "dsh-mnemon": "^0.5.17" } → npm 7+ 自动装 peer

# 反例：没发 npm = 掉出排序
$ curl https://registry.npmjs.org/dsh-memory-evolve
{"error":"Not found"}        # 426 star，商店 downloads: null，直接掉出下载量排序
```
