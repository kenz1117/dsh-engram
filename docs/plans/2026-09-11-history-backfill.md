# dsh-engram 历史会话回填 实现计划（历史对话 → 记忆宫殿）

动机：插件此前的摄取只覆盖**当前会话**（每轮第一步摄取上一轮 + 会话结束时补末轮 + pending 重放）。用户在换模型/清理前积累的历史会话内容无法进入宫殿——那些「以前聊过的偏好、决策、经历」是长期记忆最有价值的部分。

前置调研（harness 侧，已核对源码）：
- `sessionPersistence.list()` 返回全部已持久化会话的**快照**（`{ header, revision, eventCount?, sizeBytes? }`，header 含 `id` / `createdAt` / `cwd` / `parentSession` / `isSeeded` / `origin` …），**无分页无过滤**。
- 日志读取走**只读句柄**：`sessionPersistence.open(id, 'read')` → `handle.read()`（返回 `{ eventState, events }`）→ `handle.close()`。早期的 `load(id)` 已在新版 dsh 移除——插件的历史回填与 pending 重放均经 [index.ts persistenceService / makeEventResolver](../../src/index.ts) 的这层适配读取。
- 会话目录命名 `root/<project>/<encoded id>/session.jsonl.zstd`，转义与校验由 provider 承担：**走服务接口比自己遍历目录稳**。
- 无「批量导出全部会话」的既有能力；跨会话检索（`sessionQuery`）存在但工作区受限且该包默认不挂载，不作为依赖。

## 用户选择（决定设计的三项）

1. **数据范围**：dsh 自己的历史会话（非外部平台导出文件）。
2. **作用域**：**按会话 cwd 分库**——历史会话写进它自己项目的库，避免跨项目串库。
3. **成本**：保守默认——时间窗 7 天、单会话 ≤20 轮、单次总轮数硬上限 200；先估算再执行；不做后台自动跑。

补充要求：面板**独立成一个 tab**；**导入规则由用户在面板上自行选择**。

## 关键设计

1. **复用实时摄取管线**：内层直接调用 `ingestPreviousTurn({ slice: <turn> })`，提炼/脱敏/防回声/幂等键全部沿用；只新增「枚举会话 → 过滤 → 逐轮遍历 → 限额 → 进度」外层。为此给 `IngestDeps` 加了三个开关：`throttle`（历史轮次也节流）、`writeScope`（写 project 库时记录 scope 标记）、`history`（写入不排复习）。
2. **写入不排复习**（必须）：`WriteInput.initialReviewAt` 扩展为 `number | null`，`null` = 明确不进入 SM-2 调度——否则一次回填 200 条会让明天的「今日待回忆」直接淹没。桩位照常排（位置索引要保留）。
3. **按 cwd 分库**：store 缓存键从 scope 改为**分库文件名**，新增 `openStoreForProjectCwd(cwd)`；`dbNameForCwd` 带缓存并对历史 cwd 也跑一次旧库 rename 迁移。
4. **估算零副作用**：估算阶段只打开**已存在**的库文件（`existsSync` 判断）查幂等键，不因估算创建空库。
5. **幂等续跑**：`(sessionId, turn)` done 键保证重跑只补未完成轮次；暂停/崩溃后重新开始即续做。
6. **进程内 job**：面板启动的是后台任务（单例），HTTP 只轮询状态；工具调用则同步跑完（受调用方 signal 约束），适合小批量或先估算。

## 任务分解（已全部完成）

- **T1 存储层**：`openDb(dbName)` + `openStore(scope)` + `openStoreForProjectCwd(cwd)`（含 cwd→dbName 缓存与旧库迁移）。
- **T2 写入期**：`initialReviewAt: number | null`（`null` = 不排期），写入期自动化按「undefined 才走默认」判断。
- **T3 配置**：`historyBackfillDays` / `historyBackfillMaxTurnsPerSession` / `historyBackfillMaxTotalTurns` / `historyBackfillIncludeSubagents` / `historyBackfillIncludeSeeded` / `historyBackfillIncludeNoCwd`，含范围校验；`ResolvedHistoryRules` 聚合，总轮数上限为硬顶（按次只能调低）。
- **T4 摄取核心 `src/ingest/history.ts`**：`listHistorySessions`（过滤子代理/种子/无 cwd/超窗）、`estimateHistoryBackfill`（候选/规则内轮数/待处理轮数/排除计数/截断标记）、`runHistoryBackfill`（逐会话逐轮 + 进度回调 + 失败继续 + 取消）。
- **T5 工具 `engram_ingest_history`**：`dryRun` 缺省 true（只估算），显式 false 才执行；规则参数可按次覆盖。
- **T6 路由**：`GET /api/engram/history-backfill`（估算，规则走 query）、`POST .../start`、`POST .../cancel`、`GET .../status`；`history` 接口经 `RouteDeps` 注入。
- **T7 面板**：独立 tab「历史回填」——规则区（时间窗 / 单会话轮数 / 总轮数上限 / 三个过滤开关，全部持久化）、估算区、执行区（开始/暂停 + 进度条 + 跳过与失败计数 + 失败明细前 3 条），运行中每 1.5 秒轮询。
- **T8 测试**：`tests/history.spec.ts`（14 例：规则合并与硬顶、过滤计数、轮数截断、估算扣已摄取、按 cwd 分库写入、不排复习、重跑幂等、单轮失败继续、取消、损坏日志跳过、低活动节流）；组合测试加「估算 → 启动 → 轮询到结束」全链路（会话持久化以替身注入，LLM 替身离线 → 断言失败只计数不中断）；工具集计数更新到 16。
- **T9 文档**：README 双语（特性、工具表 16 个、6 个新配置键、新 tab 说明）；本文件。

## 预判的失败原因与对策（实现中落实）

| 失败原因 | 对策 |
|---|---|
| 环境无 `sessionPersistence`（headless 等） | 服务按可选注入；估算返回 `unavailable`，工具返回可读说明，面板显示不可用并禁用开始按钮 |
| 单个会话日志损坏 / 编码不匹配 | `load` 抛错被吞掉并计入 `skipped.unreadable`，不影响其余会话 |
| LLM 限流 / 超时 | 该轮记入 `failures` 并继续；done 键保证重跑只补失败轮次 |
| 回填途中进程退出 | job 状态丢失但每个已完成轮次都有 done 键 → 重新估算显示已摄取，天然续跑 |
| 成本失控 | 估算前置（零成本）+ 总轮数硬上限 + 必须显式点击/传 `dryRun=false`；不做 auto 模式 |
| 跨项目内容误写 | 按会话 cwd 分库；无 cwd 会话默认跳过（若要收也明确标注「只能进私人宫殿」） |
| 历史条目淹没复习队列 | 回填写入 `initialReviewAt: null`，不进 SM-2 调度 |

## 已知边界（留给后续）

- 标题不在 `SessionHeader` 里，因此面板不能按标题筛选（需要 `sessionQuery.readTitleSnapshots`，属可选能力）；当前按时间窗与 cwd 过滤。
- 历史 cwd 对应的库若从未被本机打开过，回填会为它创建新的分库文件（属于预期：那条会话确实属于该项目）。
- 估算与执行是两次独立请求，都会重新读一遍日志；会话极多时估算本身有 IO 成本（有限并发 4）。

## 实跑后的修正（首次真实回填暴露）

用户首跑：13 个会话 / 55 轮 → 写入 1 条、跳过 45 轮、失败 5 轮，失败原因是
`pi-ai provider "zai" has no configured model "glm-4.5-air"`。据此修三处：

1. **辅助调用优先复用当前可用路由**（`src/index.ts`）：历史日志的 `request/header` 记的是当年的 provider/model，在当前环境可能已不可用。为此 `preStep` 每轮第一步把当前会话解析到的路由记进 `preStepState.route`，历史回填的 `routeOverride` 取 `配置覆盖 ?? preStepState.route`——即「用你现在在用的模型」回填。组合测试用 zai/glm-4.5-air 的历史日志 + deepseek 的当前会话验证：辅助调用走 deepseek，不回落到 zai。
2. **跳过原因分布**（`src/ingest/history.ts`）：`HistoryRunProgress.skipReasons` 按摄取管线的跳过枚举（low-activity / chitchat / capture-forbidden / no-user-content / already-ingested / no-route-in-log / unparsable）分别计数，面板与工具输出都展示——「写入很少」因此可解释（多半是节流跳过，不是失败）。
3. **失败明细可读**：会话 id 原按前 8 位截断显示成 `session-`（无信息量），改为显示尾部 12 位；并在有失败时给出行路由不可用的可操作提示（配 provider/model，或用目标模型先跑一轮再重试；已完成的轮次会自动跳过）。
