<div align="center">

# dsh-engram

<p align="center">DeepSeek Harness 跨会话长期记忆插件 — Agent 在会话与项目之间记住用户偏好、项目约定与经历事实，并随使用持续演化（摄取 → 强化 → 蒸馏 → 衰减）。纯 TypeScript，零外部进程、零 Python 依赖。</p>

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

## 特性

- **跨会话记忆**：会话开始注入用户画像摘要（至多 8 条，可配），Agent 天然"记得"你是谁、在做什么；工具检索跨会话召回历史事实。
- **双层分库**：`user.db` 全局共享；`project-<cwd>.db` 按工作目录隔离——个人偏好跟人走，项目约定跟仓库走。
- **混合检索**：FTS5（unicode61 + 中文 2-gram 预切词）与本地向量（`Xenova/bge-small-zh-v1.5`，512 维，q8）RRF 融合 + 关系边一跳扩展；嵌入模型离线运行，下载失败自动降级纯关键词并显式标记。
- **知识飞轮**：摄取/保存 → 矛盾候选（写入时高相似近邻建 `contradicts` 边并报告，模型/用户裁决）→ 命中强化（confidence +0.05）→ 蒸馏（同主题簇合并为高层规律、supersedes 取代链、置信度继承）→ 衰减（低重要性且长期未访问归档，可恢复）。
- **自动摄取**（`ingest` 配置开启时）：新一轮第一步从会话日志提取上一轮的候选事实，低 confidence 写入并按嵌入去重——不说"记住"也能攒记忆。
- **来源审计**：每条记忆记录来源会话、轮次与事件 seq，`engram_review` 完整回查来源链、取代链、矛盾与操作日志；全部写入/修改/遗忘/蒸馏/衰减入操作日志表。
- **Web 管理面板**：设置页「记忆库」tab——统计卡片、按状态/种类/内容过滤、行内详情与编辑（走取代链）、遗忘/恢复、导出 Markdown/JSON。界面文案中英双语，跟随宿主语言设置实时切换。
- **数据可携带**：`engram_export` 一键导出 Markdown / JSON 文件。

## 工具（9 个，窄参数）

| 工具 | 作用 |
|---|---|
| `engram_save` | 保存（嵌入可用时自动做矛盾候选检测） |
| `engram_search` | 语义 + 关键词混合检索（命中强化置信度） |
| `engram_timeline` | 时间线浏览 |
| `engram_update` | 修正（supersedes 取代链） |
| `engram_forget` | 遗忘（软删可恢复） |
| `engram_review` | 审计单条：来源链、取代链、矛盾、操作日志 |
| `engram_stats` | 全库统计与信噪比 |
| `engram_export` | 导出 Markdown / JSON 文件（数据可携带） |
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
    modelCacheDir: '~/.dsh/engram/models'  # 嵌入模型缓存目录
    hfEndpoint: 'https://huggingface.co'   # 模型下载端点，网络受限可配镜像
    ingest: 'off'                   # 自动摄取：off | light（仅用户消息，每轮≤2条）| eager（含助手消息，每轮≤5条）
    # provider 与 model 必须成对提供：摄取/蒸馏的辅助 LLM 路由覆盖（缺省从会话日志解析）
    # provider: 'deepseek'
    # model: 'deepseek-v4-flash'
    decayAfterDays: 30              # 衰减：最近访问超过该天数
    decayImportanceBelow: 0.3       # 衰减：且 importance 低于该值 → 归档（可恢复）
```

## 工作原理

插件由宿主半（Node）与浏览器半（React）组成：

```
会话 Agent                                 宿主半（Node）
  │                                          │
  ├─ 每轮第一步 ◀─────────────────────────── ├─ 用户画像快照注入（plugin 来源 user 快照）
  ├─ engram_save / search / review … ──────▶ ├─ SQLite 双库（user.db / project-<cwd>.db）
  │                                          ├─ FTS5 关键词道 + 本地向量道 RRF 融合
  ├─ engram_distill ───────────────────────▶ ├─ 辅助 LLM 蒸馏（簇合并 → supersedes 链）
  │                                          └─ 自动摄取：会话日志 → 候选事实（ingest 开启时）
  └─ 设置页「记忆库」tab ◀────────────────── ─── 回环 API /api/engram/*（写操作校验回环 Origin）
```

- **双层分库**：`user.db` 全局共享；`project-<cwd>.db` 按工作目录隔离。
- **自动摄取**（`ingest` 开启时）：新一轮第一步从会话日志提取上一轮的候选事实（读取源是会话日志；辅助调用的请求审计走插件自身操作日志，不向会话日志 append 未知事件）。候选以低 confidence 写入并按嵌入去重。
- **来源链**：每条记忆记录来源会话、轮次与事件 seq，`engram_review` 可完整回查；操作日志表记录全部写入/修改/遗忘/蒸馏/衰减。
- **嵌入离线**：模型首次使用需联网下载（q8 约 50MB，端点可配镜像），此后完全离线；失败时插件照常工作，检索降级纯关键词并显式标记。
- **界面本地化**：client 半经宿主 locale 服务注册 zh/en 词典，跟随宿主语言设置实时切换；状态/种类等数据枚举仅在显示层映射，存储值保持英文。

## Web 管理面板（设置页「记忆库」tab）

宿主带 webServer 的 profile（web 等）会在**设置页**自动出现「记忆库」tab（经 `settings.section` 槽位注册，client 半为 React 组件、随 `lib/client.js` 由宿主模块表装载）：统计卡片、按状态/种类/内容过滤、行内详情与编辑（走取代链）、遗忘/恢复、导出 Markdown/JSON 下载。数据经回环 API `/api/engram/*`（写操作校验回环 Origin）。headless 等无 webServer 的组合不挂载，其余能力不受影响。

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

会话每轮第一步追加一条 plugin 来源的 user 快照：`User memory profile (dsh-engram, cross-session):` 加用户级记忆列表（默认至多 8 条，`injectProfile: false` 关闭）。工具调用结果为纯文本行列表（含 `id=`、scope/kind 标注、矛盾候选提示与降级说明）。自动摄取与蒸馏各产生一次辅助 LLM 调用（独立于主对话计费路径，带 purpose 归因）。

#### Token effect

画像注入为条件性固定成本（条数 × 内容长度）；工具 schema 为常驻成本（9 个窄参数工具）。

#### KV Cache effect

画像文本随记忆库内容变化——变化只体现在新会话或记忆更新后的轮次边界；同一会话内注入内容不变时前缀保持稳定；工具 schema 恒定，不影响前缀。

## Known Limitations and Deferred Work

- **自动摄取的最后一轮盲区** —— 摄取由下一轮的第一步触发，会话最后一轮不摄取；会话结束事件钩子是后续工作。
- **矛盾候选无 LLM 判定** —— 写入时仅按向量相似度（≥0.88）报告候选并建边，语义矛盾的确认留给模型/用户裁决与蒸馏。
- **嵌入器降级期间的记忆无向量** —— 模型未就绪时写入的记忆不参与语义道；语义上线后跑一次 `pnpm backfill` 补算存量向量（`pnpm build` 的模型缓存就绪后执行，可经 `HF_ENDPOINT` 配镜像）。

## 许可证

[MIT](LICENSE) © 2026 KenZ (kenz1117)
