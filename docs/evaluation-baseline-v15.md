# Engram 0.12.0 评测基线（schema v15）

状态：本地确定性基线，非公开榜单成绩。  
基线代码：`feat/0.12.0`  
评测器：`src/evaluation/recall.ts`  
测试 fixture：`tests/evaluation.spec.ts`

## 目标

给 0.12.0 的引擎改动建立可重复、无网络、无外部模型的对照面。它不是替代 LongMemEval；公开集接入仍单独做。当前基线回答三个问题：

1. 相关记忆能否进入 top-k？
2. 知识更新后是否返回当前修订而不是旧版？
3. 无关查询是否被拒答，而不是硬凑记忆？
4. 每个候选是否携带稳定身份、revision、score 和检索通道？

## 语料

- 3 条目标记忆：偏好、项目事实、知识更新链。
- 1 条知识更新链：Jest → Vitest；旧版归档，新版 active。
- 12 条干扰记忆。
- 2 条 episode：目标部署会话 + 无关桌面整理会话。
- 1 条注入回放 fixture。
- 默认 `k=5`，关键词道降级运行（无向量），显式标记 `degraded=true`。

## 能力与指标

| 能力 | 指标 | v15 基线 |
|---|---|---:|
| recall | Recall@5 / Hit@5 / MRR | 1.00 / 1.0 / 1.00 |
| knowledge-update | 当前修订 top1 + stable memoryId | pass |
| temporal | session 过滤 + 组内时间升序 | pass |
| abstention | 无关查询 top score `<0.05` 或空结果 | 1.00 |
| provenance | stable ID + revision ID + score + via 完整率 | 100%（4/4 retrieval cases） |
| injection replay | API packet 与实际 packet 逐字一致 | pass |

## 边界

- 这是 DSH 私域 smoke/回归基线，不是公开榜单成绩；不能宣称 LongMemEval 或 LongMemEval-V2 达标。
- 当前基线没有启用真实 embedding 或 LLM rerank，因此测量的是关键词降级路径。
- 拒答阈值 0.05 是 fixture 内阈值，不能直接迁移到生产分布或公开数据集。
- LongMemEval 接入应作为独立后续项：需要外部数据、模型 reader、成本预算和稳定 reader/judge 版本。
