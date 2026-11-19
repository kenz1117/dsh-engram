# 配置速查表（Config Reference）

> `@kenz1117/dsh-engram` **v0.13.14**（commit `b11d6c4`）的**全部 51 个配置键**，逐条说明。
> 配套文档：[术语表](./glossary.md)
>
> 所有默认值取自 `src/config.ts` 的 `resolveConfig()`（唯一默认值落地处），所有行号可自行复核。
>
> **本表与 `src/config.ts` 同步维护**：新增、改名或调整默认值的配置键，必须一并更新本表（`src/config.ts` 的 `EngramConfig` 注释里有同样的提醒）。表与代码对不上，使用者查到的就是错的。

---

## 0. 三处设置，一个对照

这是最容易让人困惑的地方，先说清楚：**可调项分布在三处，且各管各的**。

| 位置 | 管什么 | 落点 |
|------|--------|------|
| **DSH 设置页的插件条目** | 宫殿语言等宿主级设置 | 宿主配置 |
| **面板「裁决」页 / 「回填」页** | Jev 提供商/协议/模型/阈值/超时；回填时间窗与轮数上限 | 面板改动写在插件的 `jev-config.json` 覆盖文件里；`cordis.yml` 的 `jev.*` 是**基线** |
| **`cordis.yml` 插件配置** | 摄取档位、信念巩固、辅助模型、衰减阈值、复习预算等 | 宿主 schema |

> **v0.13.14 已在裁决页与回填页的说明折叠里点明各自的落点**（`hintJevConfig` / `hintBackfillConfig`），并在每个字段旁直接写出对应配置键名（`cfgKeyLabel` 模板）。

**`cordis.yml` 里未知键会直接报错**（`src/config.ts:391-393`），拼错就启动不了——这是好事，能第一时间发现拼写错误。

---

## 1. 全部 51 个配置键

**分组**：数据与存储 6 / 摄取与巩固 4 / 注入画像 6 / 排序检索 3 / 位置复习提醒 5 / 衰减 2 / 历史回填 6 / 面板访问 1 / 裁决 Jev 9 / 嵌入器 9 = **51**。
>
> **计数口径**：`src/config.ts` 的 `Config` schema 顶层有 35 个键，其中 `jev` 与 `embedder` 是**容器**（各自还有子对象），本身不是叶子键。叶子键 = 顶层 33 + jev 9 + embedder 9 = **51**。

### 1.1 数据与存储（6 个）

| 键 | 类型 / 默认 | 大白话 |
|----|-----------|--------|
| `dbDir` | 字符串，`$DSH_HOME/engram` | **三个库文件放哪**。默认跟着宿主的 `$DSH_HOME` 走（不是写死 `~/.dsh/engram`，见 `src/config.ts:575-580`）。搬到别的盘时记得改，不然库留在旧盘上而且**完全静默** |
| `legacyMigration` | `eager` \| `conservative`，默认 `eager` | 旧版本库的迁移策略。`eager` = 自动迁移；`conservative` = 保留旧库等人工确认 |
| `modelCacheDir` | 字符串，`<dbDir>/models` | 嵌入模型缓存在哪 |
| `hfEndpoint` | 字符串，默认 `huggingface.co` | 模型下载源。**国内网络必须改成镜像**（如 `https://hf-mirror.com`），否则第一次用向量检索就卡住 |
| `language` | `auto` \| 显式语言码 | **宫殿语言**：插件自己说话的语言（房间名、工具说明、系统提示）。`auto` = 从系统区域设置取。⚠️ 改它会**重算全部向量**，所以有 `palaceChangeWindowSec` 那道保险 |
| `redactWords` | 字符串数组，默认 `[]` | 你自己补充的**脱敏关键词**。语言包的规则不够用时加这里，**永远生效**、与语言无关 |

> ⚠️ **`language` ≠ 面板语言**。面板顶栏那个下拉只改**面板文案**（存本机）；配置键 `language` 是**宫殿语言**（决定模型与新记录用什么语言），在面板「系统」页。两者同名不同义，v0.13.14 已在顶栏加说明点明分工（`hintPanelLanguage`）。

### 1.2 摄取与巩固（4 个）

| 键 | 类型 / 默认 | 大白话 |
|----|-----------|--------|
| `ingest` | `off` \| `light` \| `eager`，默认 **`off`** | **要不要自动从对话里提取记忆**。`off` = 只有你手动 `engram_save` 才写。`light` = 只读你的发言，每轮最多 2 条。`eager` = 连助手的发言也读，每轮最多 5 条。**每一档都要调一次辅助模型 = 花钱** |
| `reflect` | `off` \| `suggest` \| `auto`，默认 **`off`** | **要不要自动把记忆巩固成"信念"**。`suggest` = 会话开始时提醒 agent 去整理。`auto` = 会话结束后自动触发 |
| `provider` | 字符串 | 摄取/蒸馏/巩固**覆盖**用的模型提供商。必须和 `model` **成对**提供，只给一个会报错 |
| `model` | 字符串 | 同上的模型名。留空 = 用 DSH 当前在用的那个 |

> **组合提示（面板自己会警告）**：`ingest` 开着但 `reflect` 关着 → **只收集不整理**，记忆会散着越来越难读。面板原话：*"记忆只收集不蒸馏，读起来会是散的。建议在配置里设置 reflect: auto 或 suggest"*（`src/client/locales/zh.ts:483`）。

### 1.3 注入画像（6 个）

| 键 | 类型 / 默认 | 大白话 |
|----|-----------|--------|
| `injectProfile` | 布尔，默认 `true` | **会话开始时要不要把记忆画像塞进系统提示**。关掉 = agent 完全不记得你 |
| `profileTopN` | 整数 1–64，默认 **8** | 画像里最多放几条记忆 |
| `injectTokenBudget` | 整数 128–8192，默认 **1024** | 画像的 **token 硬预算**。超了就砍。这是注入侧的硬闸门 |
| `injectItemBudgetStart` | 整数 40–2000，默认 **160** | 画像里**第一条**能占多少字符 |
| `injectItemBudgetDecay` | 0.5–1，默认 **0.9** | 逐条递减系数：第一条 160 字符 → 第二条 144 → 第三条 130 … |
| `injectItemBudgetFloor` | 整数 8–200，默认 **24** | 单条字符**下限**，防止重要的那条被砍成一句话 |

> 这三个 `injectItemBudget*` 合起来实现了"**分级递减预算**"：排第 1 的记忆给足空间，排第 8 的只给 24 字符。目的是在固定 token 预算内**优先保住最重要的那条**。

### 1.4 排序与检索（3 个）

| 键 | 类型 / 默认 | 大白话 |
|----|-----------|--------|
| `rankRecencyWeight` | 0–2，默认 **0.2** | 排序时"新近"的权重。**0 = 完全不看新近** |
| `rankProofWeight` | 0–2，默认 **0.1** | 排序时"证据强度"（被复述并入的次数）的权重。**0 = 不看** |
| `queryRewrite` | 布尔，默认 **`true`** | 检索前**用辅助模型把问题改写成 ≤3 个互补查询**再分别检索、RRF 融合。**要调模型**。关掉 = 只用原词查一次 |

### 1.5 位置、复习与提醒（5 个）

| 键 | 类型 / 默认 | 大白话 |
|----|-----------|--------|
| `autoSlot` | 布尔，默认 `true` | 写入时**自动给记忆排桩位**（房间 + 序号）并登记巡游路线。关掉 = 桩位和路线全靠调用方显式指定 |
| `reviewScheduling` | 布尔，默认 `true` | 新记忆是否进入 **SM-2 间隔重复**（初始 1 天后到期）。**关掉 = 面板「复习调度」永远是 0**，而且复习中的条目不再受自动衰减保护 |
| `assessReminder` | 布尔，默认 `true` | 会话里有未判定的检索批次时，下一步开始前**提醒 agent 去判证据够不够** |
| `reflectReminder` | 布尔，默认 `true` | `reflect: suggest` 时，会话开始**提醒 agent 去整理待巩固的记忆** |
| `palaceChangeWindowSec` | 整数 5–600，默认 **30** | **改宫殿语言的"后悔时间"**：从你动手起 30 秒内可以选好语言、解除保险、点执行；超时选择作废、保险自动复位。防止手滑改了语言导致全库重算向量 |

> `palaceChangeWindowSec` 的注释是俄语的，意思是："这个数字是**设置项不是代码常量**——用户明确要求不用重新编译就能改它（'一分钟太多，30 秒'——这是他的决定，不是我们的）。面板（倒计时和标签）和服务端（请求时校验）都读它。"

> **`reviewScheduling` 关掉的连带影响**：不仅调度停摆（面板「复习调度」永远是 0，新记忆不再有到期日）。至于"正在复习中的条目不受自动衰减保护"这条——**它靠的不是这个开关，而是条目自己有没有 `next_review_at`**：`sqlDecay` 的判准是 `next_review_at IS NULL`（`src/store/sqlite.ts:749-756`），注释写得很清楚——"进入 SM-2 复习调度的条目（next_review_at 非空）不参与自动衰减：到期未复习的记忆该被优先复习而非归档，其退出由翻新清单 demote 规则（人工确认）接管"。
> 也就是说：**已经排进复习队列的条目，关掉开关后仍受保护**（它们的 `next_review_at` 还在）；**关掉开关之后新写入的条目**不再进队列，因而也不再享受这条豁免。

### 1.6 衰减（2 个）

| 键 | 类型 / 默认 | 大白话 |
|----|-----------|--------|
| `decayAfterDays` | 整数 1–3650，默认 **30** | 记忆**多少天没被碰过**才可能被自动归档 |
| `decayImportanceBelow` | 0–1，默认 **0.3** | 且**地标亮度低于**这个值才可能被归档。两个条件同时满足才动手 |

> 关键：**进了复习调度的条目不参与自动衰减**（`next_review_at IS NULL` 才扫，`src/store/sqlite.ts:749-756`）。因为"正在安排你复习"和"没人管就扔掉"不能同时成立。

### 1.7 历史回填（6 个）

| 键 | 类型 / 默认 | 大白话 |
|----|-----------|--------|
| `historyBackfillDays` | 整数 0–3650，默认 **7** | 回填的**时间窗**（往前几天）。0 = 不限 |
| `historyBackfillMaxTurnsPerSession` | 整数 1–500，默认 **20** | 单个会话最多摄取几轮 |
| `historyBackfillMaxTotalTurns` | 整数 1–5000，默认 **200** | 单次运行的**总轮数硬上限**（面板/工具参数只能调低） |
| `historyBackfillIncludeSubagents` | 布尔，默认 `false` | 要不要含子代理的会话 |
| `historyBackfillIncludeSeeded` | 布尔，默认 `false` | 要不要含"种子"会话（预置的示例会话） |
| `historyBackfillIncludeNoCwd` | 布尔，默认 `false` | 要不要含没有工作目录的会话（这类只能进用户库） |

> **回填参数按本次运行传入**（面板「回填」页上的输入框）；`cordis.yml` 的 `historyBackfill*` 是**默认值**（`hintBackfillConfig`）。

### 1.8 面板访问（1 个）

| 键 | 类型 / 默认 | 大白话 |
|----|-----------|--------|
| `panelAccess` | `loopback` \| `lan`，默认 `loopback` | 管理面板的访问面。`loopback` = 只有本机能连（**默认，安全**）。`lan` = 放行局域网内的其它设备（手机、无头服务器场景）。⚠️ 这就是"把面板开到局域网"，改之前想清楚 |

### 1.9 裁决 Jev（9 个）

| 键 | 类型 / 默认 | 大白话 |
|----|-----------|--------|
| `jev.enabled` | 布尔，默认 **`false`** | 是否启用外部模型裁决。关着 = **纯规则四态** |
| `jev.provider` | 字符串 | 用哪个 DSH 里已配置的提供商。留空 = 用当前会话正在用的那个 |
| `jev.model` | 字符串 | 判决模型名。`systemone` 协议下留空 = 用该提供商的第一个 Jev 模型；`chat` 协议下留空取第一个（任意模型） |
| `jev.endpoint` | 字符串 | 端点。留空 = 按提供商与协议推导：`systemone` → `{base}/systemone`，`chat` → `{base}/chat/completions`。**覆写时要求与提供商同源** |
| **`jev.protocol`** | `systemone` \| `chat`，默认 **`systemone`** | **v0.13.13 新增**（v0.13.14 补齐了面板说明文案）。裁决请求按什么协议发出。`systemone` = 私有协议，仅 Jev 系模型支持（模型名需匹配 `/jev/i`）；`chat` = 标准 OpenAI 兼容 chat completions，**任意模型**都能按 JSON 契约当裁决者 |
| `jev.timeoutMs` | 整数 1000–60000，默认 **3000** | 超时 |
| `jev.deferMergeAbove` | 0.5–1，默认 **0.85** | 概率**高于**它 → 判"是同一条" → 并入 |
| `jev.deferAcceptBelow` | 0–0.5，默认 **0.15** | 概率**低于**它 → 判"确实不同" → 放行 |
| `jev.contradictMinProbability` | 0.5–1，默认 **0.8** | 矛盾问题的概率高于它 → **才真正建矛盾边** |

> **约束**：`deferAcceptBelow` 必须**小于** `deferMergeAbove`，否则启动报错（`src/config.ts:532-533`）。
> **`jev.protocol` 的取值校验**：只能是 `systemone` 或 `chat`，写别的直接报错（`src/config.ts:517-519`）。

> **Jev 是什么**：不是人名、不是内部模块名，是**使用 System One 协议的判决模型家族**（模型名需匹配 `/jev/i`，如 `jev-latest`）。技术上是向 `{baseURL}/systemone` POST 一个 `{state, questions}` JSON，拿回每个"是不是同一条事实"的是非题概率。**systemone 协议不是 OpenAI-chat 兼容**，所以不能走宿主 `ctx.llm`，得自带 HTTP 客户端。
> **v0.13.14 补上了 chat 协议通道**：走标准 `{baseURL}/chat/completions`，把裁决问题作为普通 prompt 发出并按 JSON 契约 `{"answers":{"<qid>":{"p":<0-1>}}}` 解析概率，**普通聊天模型即可充当裁决者，模型名无需 jev 前缀**。
> **密钥不在插件里**：地址和 token 由 DSH 的凭据库在调用时解析，插件只存 enabled/provider/model/endpoint/protocol/timeout 六个字段。
> **不可用时静默降级**回纯规则四态，**不阻断写入**，并留一条审计行（面板"裁决"页可见）。
> 词源在仓库内无据，**推断，未确证**。

### 1.10 嵌入器（9 个）

| 键 | 类型 / 默认 | 大白话 |
|----|-----------|--------|
| `embedder.kind` | `local` \| `remote`，默认 **`local`** | 用**随包的离线模型**还是**远程 API** |
| `embedder.localModel` | 字符串 | 指定用哪个本地模型。留空 = 按语言从模型注册表取 |
| `embedder.localPooling` | `mean` \| `cls` | 池化方式。留空 = 按模型元数据（bge-m3 与同族模型需要 `cls`） |
| `embedder.model` | 字符串 | **仅 remote**：远程模型名（`kind=remote` 时必填） |
| `embedder.baseUrl` | 字符串 | **仅 remote**：端点（必填，须 http/https） |
| `embedder.apiKey` | 字符串 | **仅 remote**：密钥直接写这里 |
| `embedder.apiKeyEnv` | 字符串 | **仅 remote**：从环境变量名取密钥（**推荐**，别把密钥写进配置文件） |
| `embedder.batchSize` | 整数 1–256，默认 **32** | **仅 remote**：一批送多少条 |
| `embedder.timeoutMs` | 整数 1000–600000，默认 **30000** | **仅 remote**：超时 |

> **`kind=remote` 的硬要求**：`model` 与 `baseUrl` **都必须给**，缺一个启动报错（`src/config.ts:566-573`）。反过来 `local` 不必知道 baseUrl、也不必知道模型缓存——**只对选中的后端提要求**。

---

## 2. 按场景速查

### 2.1 "我只想让它记住我明确说过的事"（最省）

```yaml
ingest: off
reflect: off
```

零模型开销、零意外。只有你手动 `engram_save` 才写记忆。

### 2.2 "半自动，别太贵"（推荐起点）

```yaml
ingest: light        # 只读你的发言，每轮最多 2 条
reflect: suggest     # 让 agent 提醒自己去整理
```

**不要一上来就 `eager`**——每轮 5 条辅助模型调用，而且连助手的发言都读（会把助手的客套话也记进去）。

### 2.3 "全托管"

```yaml
ingest: eager
reflect: auto
```

最省心也最贵，记忆涨得最快，**遗忘/整理的压力也最大**。

### 2.4 国内网络（必做）

```yaml
hfEndpoint: 'https://hf-mirror.com'
```

不改的话第一次用向量检索就卡住，**而且不会自动回退**。

### 2.5 换裁决协议（`jev.protocol`，v0.13.13 起可用）

```yaml
jev:
  enabled: true
  protocol: chat          # 任意 OpenAI 兼容模型都能当裁决者
  model: 'your-model'
  provider: 'your-provider'
```

**好处**：不再受"只有 Jev 系模型能用"的限制。**代价**：`systemone` 的问题格式（`type: 'noul'`）与概率语义是私有协议；`chat` 协议改用普通 prompt + JSON 契约解析，**裁决质量可能不同**，建议先小范围验证。

### 2.6 面板暴露到局域网（手机看）

```yaml
panelAccess: lan
```

⚠️ 这就是"把面板开到局域网"。改之前想清楚。

---

## 3. 四个必看项

无论哪种模式，这四个都值得确认：

| 检查项 | 为什么 |
|--------|--------|
| `hfEndpoint` 改成镜像 | 不改的话第一次用向量检索就卡住，而且**不会自动回退** |
| `language` 确认 | 它决定模型和向量用哪种语言。改它会重算全库向量 |
| `panelAccess` 保持 `loopback` | 这是"把管理面板开到局域网"，别随手改 |
| `decayAfterDays` / `decayImportanceBelow` | 决定记忆多久被判"该扔了"。默认 30 天 + 0.3 比较温和 |

---

*本文档基于 `@kenz1117/dsh-engram` v0.13.14（commit `b11d6c4`）。所有默认值取自 `src/config.ts` 的 `resolveConfig()`，所有行号可自行复核。*
*术语解释见 [术语表](./glossary.md)。*
