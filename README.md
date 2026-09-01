# @kenz1117/dsh-engram

DeepSeek Harness 的跨会话长期记忆插件：Agent 在会话与项目之间记住用户偏好、项目约定与经历事实，并随使用持续演化。纯 TypeScript，零外部进程、零 Python 依赖。

[English](README.md) | 中文

## 使用本包

```sh
dsh plugin --profile web add @kenz1117/dsh-engram
```

安装后无需配置即可使用（默认分库与模型缓存在 `~/.dsh/engram`，画像注入开启）。可选配置（cordis.yml）：

```yaml
- id: dsh-engram
  name: '@kenz1117/dsh-engram'
  config:
    dbDir: '~/.dsh/engram'          # 分库与模型缓存根目录
    injectProfile: true             # 会话开始注入用户画像摘要
    profileTopN: 8                  # 注入条数上限（1-64）
    modelCacheDir: '~/.dsh/engram/models'  # 嵌入模型缓存目录
    hfEndpoint: 'https://huggingface.co'   # 模型下载端点，网络受限可配镜像
```

工具（5 个，窄参数）：`engram_save` 保存 / `engram_search` 语义+关键词混合检索 / `engram_timeline` 时间线 / `engram_update` 修正（取代链）/ `engram_forget` 遗忘（软删可恢复）。

## 理解实现

- **双层分库**：`user.db` 全局共享（偏好、通用事实）；`project-<cwd>.db` 按工作目录隔离（项目约定、决策）。
- **混合检索**：FTS5（unicode61 分词 + 中文 2-gram 预切词）与本地向量（`Xenova/bge-small-zh-v1.5`，512 维，q8 量化）RRF 融合排序，再沿关系边一跳扩展（supports/refines/related）。
- **修正走取代链**：`engram_update` 归档旧条目、写入新条目并建立 `supersedes` 边，链条完整可审计；操作日志表（op_log）记录全部写入/修改/遗忘。
- **嵌入离线**：模型首次使用需联网下载（q8 约 50MB，端点可配镜像），此后完全离线；下载失败时插件照常加载，检索自动降级为纯关键词并在结果中标记。
- **画像注入**：每轮第一步把用户级 top-N 高重要性记忆作为带 plugin 来源的动态上下文追加，不写入 system prompt，不影响 KV cache 前缀稳定性。

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

会话每轮第一步追加一条 plugin 来源的 user 快照：`User memory profile (dsh-engram, cross-session):` 加用户级记忆列表（默认至多 8 条，`injectProfile: false` 关闭）。工具调用结果为纯文本行列表（含 `id=`、scope/kind 标注与降级说明）。

#### Token effect

画像注入为条件性固定成本（条数 × 内容长度）；工具 schema 为常驻成本（5 个窄参数工具）。

#### KV Cache effect

画像文本随记忆库内容变化——变化只体现在新会话或记忆更新后的轮次边界；同一会话内注入内容不变时前缀保持稳定；工具 schema 恒定，不影响前缀。

## Known Limitations and Deferred Work

- **自动摄取未实现** —— 会话结束不从日志提取候选记忆，依赖模型显式调用 `engram_save`；二期在 session 事件流上加摄取钩子（`ingest: off | light | eager`）。
- **飞轮未实现** —— 矛盾检测、蒸馏、衰减调度与 `engram_review/stats/export/distill` 四个审计工具在二期。
- **来源链只有 sessionId** —— 轮次与事件 seq 归属随自动摄取补全。
- **Web 管理面板未实现** —— 浏览、搜索、编辑、导出记忆库的 client 半在三期。
