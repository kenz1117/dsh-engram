# Engram 0.12.0 工程契约

状态：实施中  
基线：`0.11.6` (`a452e5f`)  
参考：`bowenliang123/dsh-context` `v0.82.0` / `9a488924`

## 1. 代际目标

0.12.0 是下一代 minor，不是 1.0。保留 Engram 的产品本体、local-first、公共插件形态和成熟记忆能力；重构内部边界、召回注入、后台作业、观测回放与面板工作流。

目标闭环：

> 原始事件 → 记忆候选 → 写入处置 → 修订与证据 → 检索 → 实际注入 → 用户纠正 / 任务结果

每一次自动注入必须能回答：使用了哪条记忆的哪个 revision、为什么被选中、最终发给模型的文本是什么。

## 2. 非目标

- 不复刻 dsh-context 的通用余额、推荐、价格表或 Fleet 产品面。
- 不引入强制云服务、强制远程 LLM、强制图数据库或 API key。
- 不用图表数量、覆盖率或动画替代记忆质量。
- 不删除或原地破坏 0.11.x 数据库。

## 3. 必须保留的资产

- `user` / `project` / `shared` scope 与本地 SQLite 数据。
- FTS5 + vector + RRF、evidence gate、write-disposition。
- provenance、revision、reflect 四动作与证据死亡传播。
- 一致性备份、恢复校验、安全清洗与现有兼容 fixture。
- 本地 embedder、远程 embedder、模型注册表和多语言资产。

## 4. 核心领域不变量

### 4.1 稳定身份与不可变修订

新核心以稳定 `memory_id` 标识逻辑记忆，以不可变 `revision_id` 标识内容版本。更新不再要求逻辑身份变化；旧内容通过 revision 保留。`supersedes`、`contradicts` 和 `derived_from` 表达演化关系。

### 4.2 证据与时间

每条派生记忆可追溯到 episode / evidence。新 schema 必须能表达 `recorded_at`、`valid_from`、`valid_to`，使“当前事实”和“历史事实”可分别查询。矛盾检测独立于相似度扫描。

### 4.3 统一写边界

工具、HTTP、面板、导入和自动摄取最终都经过同一 application command：

```text
validate → authorize → scope → sanitize/redact → disposition
→ transaction → embed/index → audit
```

任何入口不得绕过清洗、脱敏、向量刷新或审计。

### 4.4 曝光不是有效反馈

检索曝光写入独立 exposure 事件，不得直接增加 confidence 或 proof。只有明确采纳、用户纠正和任务 outcome 能影响质量信号。多查询融合不得对同一条记忆重复强化。

### 4.5 最终文本唯一

用于哈希、审计、回放和实际注入的文本必须来自同一个最终字符串。禁止出现“理由影响 hash 但未进入模型可见内容”的分叉。

### 4.6 会话隔离

注入去重、compaction 计数、证据提醒和路由状态必须以 `session.id` 为键。后台重放的全局一次性状态与单会话状态分开。项目库按当前会话 cwd 解析，不以插件启动 cwd 代替。

### 4.7 持久后台作业

0.12.0 的新后台工作必须具备 idempotency key、attempt、lease、checkpoint 和可恢复状态。结果型失败与异常失败都必须进入相同恢复路径；不得把“返回 skipped”误判为成功。

## 5. 目标模块边界

```text
src/
  host/          DSH 生命周期与可选能力适配
  application/   command/query、权限、scope、幂等、预算
  domain/        memory、revision、evidence、event、outcome
  store/         SQLite commands、queries、migrations、index、backup
  ingest/        实时/末轮/历史摄取，仅调用 application commands
  retrieve/      查询理解、混合召回、融合、重排、预算
  inject/        session coordinator、composer、snapshot
  jobs/          lease、attempt、checkpoint、dead-letter
  telemetry/     真实 usage/latency/degradation/quality 指标
  client/        按工作面拆分的视图与实例级请求状态
```

迁移期允许旧模块委托新边界，但新核心不得反向依赖旧巨型装配文件。

## 6. 数据迁移与回退

- 旧 schema v13 数据库作为只读来源；先以 SQLite 一致性快照备份。
- 新导入器直接读取旧库，不使用现有有损 JSON/Markdown 导出作为迁移事实源。
- 迁移覆盖 nodes、edges、entities、node_entities、facts、observations、revisions、profile blocks、session summaries 和必要审计状态。
- embedding 按模型身份与 revision 处理；模型不明或世代不一致时显式重嵌，不只比较维度。
- 切换前输出各实体数量、关系数量、证据数量与校验报告；失败时旧路径保持可用。
- 旧库不删除。回退不得要求新库逆向写回旧 schema。

## 7. 可观测与性能

借鉴 dsh-context 的 versioned projection、head/detail、revision 防旧响应覆盖和有界缓存，但不复制其 O(N) 冷读。列表 API 必须分页/查询下推，不得 `exportAll()` 后截顶。

建议验收预算（M0 实测后调整并冻结）：

- 50k 记忆本地召回 p95 < 300ms，不强制调用 LLM。
- 后台巩固不在宿主主线程执行无界 O(N²) 工作。
- 面板首屏不加载完整记忆正文或全库边表。
- 实际值、宿主观测值与估算值在 UI 和导出中明确区分。

## 8. 验收基准

- 私有 DSH 工作流：偏好、项目约束、知识更新、矛盾纠正、跨会话续接、误记忆拒答。
- LongMemEval：信息抽取、多会话推理、知识更新、时间推理和 abstention。
- 指标：Recall@k、最终回答准确率、过期/矛盾记忆注入率、每成功任务注入 token、p50/p95 延迟。
- 故障：在候选写入、索引、done/pending 审计和迁移切换点强制终止，验证恢复与幂等。
- 安全：所有记忆出口统一不可信包装；自定义 endpoint 不得获得非可信 origin 的宿主凭据。
- 工程：PR/发布门禁包含 typecheck、完整测试、bundle、package smoke 与受支持 DSH 基线。

## 9. 实施切片

1. **P0 与契约**：Jev 凭据边界、注入装配、结果型失败恢复、完整检查。
2. **核心垂直切片**：稳定身份 + revision、统一 command、durable job、v13 导入。
3. **召回注入**：session 隔离、曝光/outcome 分离、injection snapshot、独立矛盾对账。
4. **观测与面板**：真实投影、head/detail、召回台、治理、上下文回放。
5. **发布**：兼容矩阵、迁移/回退演练、性能与安全门禁、文档和演示。

每个切片单独审查和验证；不通过一次性不可审查的大提交完成 0.12.0。

## 10. 已落地的第一个垂直切片

- Jev 凭据 origin 边界与真实 HTTP 回归。
- 注入开关、最终包理由/到期提示、session 级状态与清理。
- 末轮结果型失败的 pending 恢复与幂等测试。
- `src/application/memory-commands.ts`：工具和面板共用更新命令，旧向量可显式失效。
- schema v14 `injection_snapshots`：实际 packet 逐字持久化，head/detail API 与 v13→v14 迁移测试。
- `search-exposure`：检索不再修改 confidence/accessCount/lastAccessedAt，曝光审计与真实 outcome/reinforce 分离。
- `src/jobs/`：持久队列、过期租约硬 guard、reflect 串行调度与宿主接入；启动恢复过期 running 作业，stop 保留可重试状态。对抗审查后补齐：disposed 入队异常防线、dispose 事件水位代际 ID、毒丸作业隔离、终态作业与注入快照 366 天保留。
- schema v15 稳定身份：`nodes.id` = revision id，`memory_id` = 稳定逻辑身份；存量迁移、`getMemory`、稳定身份定位更新、聚合修订链、归因/快照稳定 ID、restore 单 active 不变量与 `VACUUM INTO` 一致性升版快照已落地。
- v13 全保真迁移演练：直接构造无 `memory_id`、无 `injection_snapshots` 的 v13 SQLite fixture，覆盖 nodes/edges/revisions/tour routes/profile blocks/profile versions/session summaries/entities/node_entities/facts/observations/op_log/FTS；迁移后验证稳定身份、修订链、检索、时间线、信念证据、状态键和 v14 快照写入，并用 `.pre-migration` 快照演练原库回退。JSON/Markdown 导出仍只作搬运，不作迁移事实源。
- 本地评测基线：`src/evaluation/recall.ts` + DSH 私域 fixture 固定 Recall@k / Hit@k / MRR、知识更新、时间线、拒答与 provenance 指标；注入回放校验 packet 逐字一致。基线结果见 `docs/evaluation-baseline-v15.md`，公开 LongMemEval 接入仍是独立后续项。
- 上下文回放工作面：面板新增「上下文回放」页；列表 head-only、详情按 id 读取，按 scope/session 过滤，展示完整 packet、SHA-256、稳定记忆 ID、包大小与压缩数。UI 直接消费事实源，不重建相似文本；zh/en/ru 齐备。
- 召回台与治理面：召回命中展示稳定身份/revision 并可打开铭牌；治理队列暴露双侧 active 的 contradicts 边，支持改判为 related 或闭馆指定侧；改判写 governance 审计，闭馆走证据死亡传播。走廊页提供处置卡片，处置前展示完整双侧与稳定 ID。

后续切片必须复用这些边界，而不是在旧工具、路由或面板里重新长一套平行规则。
