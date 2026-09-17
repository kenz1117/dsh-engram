# 摄取作用域路由（实时 + 历史回填逐条判宫殿）

动机：实时自动摄取把作用域写死成 `user`（`ingestPreviousTurn` 一律 `openStore('user')` + `scope: 'user'`），
于是项目决策/约定被塞进私人宫殿，还随画像注入带到每个项目——与「个人偏好跟人走、项目约定跟仓库走」相悖。
历史回填虽已按会话 cwd 分库，但整条会话一个口径，跨项目通用的个人偏好照样被钉在项目库里。

## 设计

1. **提炼即判宫殿**：`INGEST_SYSTEM` 输出项增加 `scope`（`project|user`）。判据：只跟当前项目/仓库有关的
   （技术选型、项目约定、架构决策、该项目自身的事实）→ `project`；与具体项目无关、跨项目通用的
   （个人偏好、习惯、用户本人经历、通用事实）→ `user`；**拿不准用 project**。
2. **默认口径按会话归属**：有 cwd 的会话默认 `project`（落该 cwd 的项目分库），模型可把明显跨项目的条目标成 `user`
   落私人库；**无 cwd 的会话只能进私人库，故关掉逐条判定**——否则 `scope: 'project'` 写进 user.db 后
   检索按 scope 过滤会看不到（分库与 scope 标记必须一致）。
3. **路由是三个扁平字段**（`IngestWriteRouting`）：`writeScope`（兜底作用域）、`perCandidateScope`（是否采纳模型值）、
   `resolveStore(scope)`（按作用域解析分库）。由 `ingestWriteRouting(cwd, openProjectStore, openScopeStore)` 组装，
   实时三条路径（上一轮 / disposed 末轮 / pending 重放）与历史回填共用同一实现。
4. **历史回填同口径**：候选会话按 cwd 组装路由（有 cwd → 默认 project + 逐条判；无 cwd → user 且不判）。
5. **幂等键与写入落点解耦**：`ingest-done` / `ingest-pending` 是会话级的，统一固定在 user 库
   （`openAuditStore`，缺省回退 `openStore()`）。否则写进项目库后，pending 重放（`listAuditDetails` 只在 user 库）
   会漏检 → 同一 (会话, 轮次) 重复摄取；统一后实时与回填也共用一份键。`estimateHistoryBackfill` 的
   「已摄取」计数随之改为只查 user 库（估算仍不建空库）。
6. **去重就近**：嵌入近邻去重（`findContradictions`）改在目标分库上做——同库同 scope 判定，跨库不做近邻。
7. **pending 重放的 cwd 来源**：新版 dsh 的 `sessionPersistence` 只有句柄式 `open(id,'read')`；句柄的
   `header.cwd` 即该会话的项目归属（本会话用 `agent.session.header.cwd`）。适配层
   `makeSessionResolver` 返回 `{ events, cwd }`，取不到 cwd 则降级为私人宫殿口径（不报错、只少一次项目路由）。

## 不做什么

- 不加配置开关（调用方统一走新口径；旧行为不可配置回退）。
- 不改画像注入：注入仍只读私人库（项目库记忆靠 `engram_search` 召回），本次不动。
- 不迁移历史键：此前写在项目库里的 done 键成为孤儿，历史回填可能对同一 (会话, 轮次) 重摄取一次（一次性）。

## 影响面

- `src/ingest/hook.ts`：prompt 加 `scope`；`IngestDeps` 加 `perCandidateScope` / `resolveStore` / `openAuditStore`；
  写入循环按候选 scope 选库；done/pending 键走审计库；`IngestWriteRouting` + `ingestWriteRouting` 新增；
  `ReplayIngestDeps.resolveEvents` → `resolveSession`（带 cwd）+ `resolveStore`。
- `src/ingest/history.ts`：`CandidateSession.routing` 取代 `writeScope`/`storeKey`；`resolveExistingStore` 删除；
  估算查 user 库；摄取传 `openAuditStore: openUserStore` + 路由。
- `src/index.ts`：`sessionCwd` / `makeSessionResolver`（句柄 header 取 cwd）；`preStep` 增 `openStoreForProjectCwd`
  形参并按会话 cwd 组装路由；disposed 路径同口径；`openProjectStoreIfExists` 删除。
- 测试：`ingest.spec`（路由三态、模型 scope 采纳/回退、审计键落点、重放按 cwd 落项目库）、
  `history.spec`（键在 user 库、回填采纳模型 scope）、`composition.spec`（句柄带 header、fake agent 带 session.header）。
