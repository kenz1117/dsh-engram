/**
 * Словарь: ядро плагина — профиль сессии, бюджет токенов, предложение экскурсии,
 * обоснование отбора, образцы памяти.
 *
 * Ключи этой области начинаются с `core.`. Оригинальный китайский текст автора
 * сохранён в `zh`; английский набор — образец полноты, русский может быть неполным
 * (недостающее берётся из английского).
 *
 * @module @kenz1117/dsh-engram/i18n/catalog/core
 */

/** Оригинальные формулировки автора. */
export const zh = {
  // ---- Профиль сессии (renderProfileDetailed / renderProfileParts) ----
  'core.profileHeader': 'User memory profile (dsh-engram, cross-session) — Grand Hall (always present):',
  'core.profileFooter': 'Use engram_search to recall details (pass room to search inside one room); use engram_save to persist new facts.',
  'core.curatedHeader': 'Curated profile (user-maintained via engram_profile_edit; authoritative over derived facts):',
  'core.observationsHeader': 'Consolidated beliefs (distilled from multiple stored memories; verify against sources before high-stakes use):',
  'core.observationItem': '- {belief} ({count} sources)',
  'core.reviewDue': '\nPalace review due today: {count}{plus} memories. Use engram_review_queue for active recall (recall beats re-reading).',
  'core.compressSystem': '把记忆条目压缩为更短的一句话表述（每条不超过 40 个字符），保留可跨会话复用的关键信息（事实、偏好、决策、方法）。\n只输出一个 JSON 数组，每项形如 {"id": "原样返回的id", "content": "压缩后表述"}，条目数量与 id 必须与输入一一对应。\n不要输出 JSON 以外的任何内容。',

  // ---- Обоснование отбора (selection-rationale) ----
  'core.rationaleHeader': '本轮画像共 {count} 条记忆，挑选理由如下：',
  'core.rationaleFooter': '如果某条理由错误，请通过 engram_report 反馈，越准的画像越能帮你。',
  'core.reasonBase': '基础入选',
  'core.reasonRecent': '近期被参观',
  'core.reasonBright': '地标明亮',
  'core.reasonCorridorHit': '走廊常客',
  'core.reasonStrongEvidence': '管家验证有效',

  // ---- Предложение экскурсии (tour-proposal) ----
  'core.tourEmpty': '[{scope}] 宫殿尚空。建议：先放第一段记忆（例如一条 fact 或 preference），让后续会话有锚点可循。',
  'core.tourGreeting': '[{scope}] 宫殿现存 {count} 条 active 记忆。建议开场巡游：{stops}。',
  'core.tourStop': '第 {index} 站「{preview}」',

  // ---- Образцы памяти (palace-sample) ----
  'core.samplePreference': '我喜欢简洁的命令行界面与键盘流胜过鼠标点击。',
  'core.samplePreferenceCaption': '竹简翻页',
  'core.samplePreferenceTag0': '纸香',
  'core.samplePreferenceTag1': '木桌',
  'core.sampleFact': '默认使用 macOS，shell 是 zsh + oh-my-zsh，编辑用 Neovim。',
  'core.sampleFactCaption': '磨砂铝机',
  'core.sampleFactTag0': '金属凉',
  'core.sampleFactTag1': '键声脆',
  'core.sampleDecision': '2024 年起所有个人项目都用 TypeScript + pnpm 工作区，理由：单仓库多包协作最稳。',
  'core.sampleDecisionCaption': '白漆棋盘',
  'core.sampleDecisionTag0': '釉面凉',
  'core.sampleEpisode': '第一次完整读《记忆宫殿》那本书——上中学时在图书馆角落读完，窗外是雨。',
  'core.sampleEpisodeCaption': '雨窗铜铃',
  'core.sampleEpisodeTag0': '钟声',
  'core.sampleEpisodeTag1': '潮气',

  // ---- Диагностика (console) ----
  'core.warnReplayPendingFailed': '[dsh-engram] 待补做摄取重放失败（保留 pending，不影响对话）：',
  'ingest.replayKeyFailed': '[dsh-engram] 重放单条 pending 失败（保留，下个会话重试）：',
  'ingest.replayAbandoned': '[dsh-engram] 陈旧 pending 放弃重放（会话超 14 天仍失败，出队）：',
  'ingest.candidateFailed': '[dsh-engram] 单条摄取候选落库失败（跳过该条，其余候选照常）：',
  'core.warnIngestPreviousFailed': '[dsh-engram] 本轮自动摄取失败（已跳过，不影响对话）：',
  'core.warnHistoryBackfillFailed': '[dsh-engram] 历史回填失败：',
  'core.warnDisposeFinalFailed': '[dsh-engram] 会话结束的收尾处理异常（不影响对话）：',
  'core.warnReflectFailed': '[dsh-engram] 会话结束的信念巩固异常（{scope}，不影响对话）：',
  'core.warnDecayStartupFailed': '[dsh-engram] 启动衰减调度失败（跳过）：',
  'core.warnDecayPeriodicFailed': '[dsh-engram] 周期衰减调度失败（跳过）：',
  'core.warnConsolidationFailed': '[dsh-engram] 闭馆整理失败（不影响对话）：',
  'core.warnEmbedderUnavailable': '[dsh-engram] 嵌入器不可用，检索降级为纯关键词模式：',
  'core.warnLabelStampFailed': '[dsh-engram] 打开 {file} 时未能写入模型标记——该库保持无标记：',
  'core.warnRoomFull': '[dsh-engram] 房间已满，自动开新房「{room}」（可在管理面板翻新清单中人工拆分/命名）',
  'core.warnJevLegacyFields': '[dsh-engram] {where} 中的 jev.{field} 已不再读取：令牌与地址现取自 jev.provider 所指的 DSH 提供商——请把密钥迁入该提供商的密钥库，并删除这个字段',
  'core.warnSlotsBackfilled': '[dsh-engram] 存量记忆排桩完成：{count} 条已钉入宫殿（{path}）',
  'core.logReflectDone': '[dsh-engram] 信念巩固完成（{scope}）：新建 {formed}，细化 {refined}，维持 {confirmed}，否定 {refuted}',
  'core.logConsolidationDone': '[dsh-engram] 闭馆整理完成：归档 {archived}，合并 {merged}，跳过 {skipped}（{ms} ms）',
  'core.warnDecayArchived': '[dsh-engram] 衰减调度：{label} 库归档 {count} 条低价值记忆（可在 engram_review 查证）',
  'core.decayTargetProject': 'project「{title}」',
  'core.backfillBusy': '已有回填任务正在运行，请先暂停或等待完成',
} as const

/** Английский набор — образец полноты. */
export const en = {
  // ---- Session profile (renderProfileDetailed / renderProfileParts) ----
  'core.profileHeader': 'User memory profile (dsh-engram, cross-session) — Grand Hall (always present):',
  'core.profileFooter': 'Use engram_search to recall details (pass room to search inside one room); use engram_save to persist new facts.',
  'core.curatedHeader': 'Curated profile (user-maintained via engram_profile_edit; authoritative over derived facts):',
  'core.observationsHeader': 'Consolidated beliefs (distilled from multiple stored memories; verify against sources before high-stakes use):',
  'core.observationItem': '- {belief} ({count} sources)',
  'core.reviewDue': '\nPalace review due today: {count}{plus} memories. Use engram_review_queue for active recall (recall beats re-reading).',
  'core.compressSystem': 'Compress each memory entry into a shorter single-sentence wording (at most 40 characters per entry), keeping the key information that can be reused across sessions (facts, preferences, decisions, methods).\nOutput only one JSON array, each item shaped like {"id": "the id returned verbatim", "content": "the compressed wording"}; the number of items and the ids must correspond one-to-one with the input.\nDo not output anything other than JSON.',

  // ---- Selection rationale (selection-rationale) ----
  'core.rationaleHeader': 'This profile holds {count} memories in total; they were picked for the following reasons:',
  'core.rationaleFooter': 'If any reason is wrong, report it via engram_report — the more accurate the profile, the better it helps you.',
  'core.reasonBase': 'base inclusion',
  'core.reasonRecent': 'visited recently',
  'core.reasonBright': 'bright landmark',
  'core.reasonCorridorHit': 'corridor regular',
  'core.reasonStrongEvidence': 'verified effective by the curator',

  // ---- Tour proposal (tour-proposal) ----
  'core.tourEmpty': '[{scope}] The palace is still empty. Suggestion: store your first memory (a fact or a preference, for instance) so later sessions have an anchor to follow.',
  'core.tourGreeting': '[{scope}] The palace currently holds {count} active memories. Suggested opening tour: {stops}.',
  'core.tourStop': 'stop {index} “{preview}”',

  // ---- Sample memories (palace-sample) ----
  'core.samplePreference': 'I prefer a lean command-line interface and keyboard-driven flow over mouse clicks.',
  'core.samplePreferenceCaption': 'bamboo slips turning',
  'core.samplePreferenceTag0': 'scent of paper',
  'core.samplePreferenceTag1': 'wooden desk',
  'core.sampleFact': 'Uses macOS by default; the shell is zsh + oh-my-zsh and the editor is Neovim.',
  'core.sampleFactCaption': 'brushed aluminium machine',
  'core.sampleFactTag0': 'cold metal',
  'core.sampleFactTag1': 'crisp key clicks',
  'core.sampleDecision': 'Since 2024 every personal project uses TypeScript + pnpm workspaces — a single repository with many packages is the steadiest way to collaborate.',
  'core.sampleDecisionCaption': 'white-lacquered chessboard',
  'core.sampleDecisionTag0': 'cool glaze',
  'core.sampleEpisode': 'Reading “The Memory Palace” all the way through for the first time — finished it in a library corner in secondary school, rain outside the window.',
  'core.sampleEpisodeCaption': 'bronze bell by the rain-streaked window',
  'core.sampleEpisodeTag0': 'bell tone',
  'core.sampleEpisodeTag1': 'damp air',

  // ---- Diagnostics (console) ----
  'core.warnReplayPendingFailed': '[dsh-engram] Replaying a pending ingest failed (pending kept, conversation unaffected):',
  'ingest.replayKeyFailed': '[dsh-engram] Replaying one pending key failed (kept for next session):',
  'ingest.replayAbandoned': '[dsh-engram] Stale pending abandoned (session older than 14 days, still failing — dequeued):',
  'ingest.candidateFailed': '[dsh-engram] one ingest candidate failed to write (skipped; remaining candidates proceed as usual):',
  'core.warnIngestPreviousFailed': '[dsh-engram] Automatic ingest of this turn failed (skipped, conversation unaffected):',
  'core.warnHistoryBackfillFailed': '[dsh-engram] History backfill failed:',
  'core.warnDisposeFinalFailed': '[dsh-engram] Session-end finalisation threw (conversation unaffected):',
  'core.warnReflectFailed': '[dsh-engram] Belief consolidation at session end threw ({scope}, conversation unaffected):',
  'core.warnDecayStartupFailed': '[dsh-engram] Startup decay scheduling failed (skipped):',
  'core.warnDecayPeriodicFailed': '[dsh-engram] Periodic decay scheduling failed (skipped):',
  'core.warnConsolidationFailed': '[dsh-engram] Closing-time consolidation failed (conversation unaffected):',
  'core.warnEmbedderUnavailable': '[dsh-engram] Embedder unavailable; retrieval degrades to keyword-only mode:',
  'core.warnLabelStampFailed': '[dsh-engram] Could not write the model label when opening {file} — the base stays unlabeled:',
  'core.warnRoomFull': '[dsh-engram] Room full; opening a new room “{room}” automatically (split or rename it by hand in the panel’s slot-list view)',
  'core.warnJevLegacyFields': '[dsh-engram] jev.{field} in {where} is no longer read: the token and endpoint now come from the DSH provider named by jev.provider — move the key into that provider’s credential store and delete the field',
  'core.warnSlotsBackfilled': '[dsh-engram] Existing memories slotted: {count} pinned into the palace ({path})',
  'core.logReflectDone': '[dsh-engram] Belief consolidation done ({scope}): {formed} formed, {refined} refined, {confirmed} confirmed, {refuted} refuted',
  'core.logConsolidationDone': '[dsh-engram] Closing-time consolidation done: {archived} archived, {merged} merged, {skipped} skipped ({ms} ms)',
  'core.warnDecayArchived': '[dsh-engram] Decay scheduling: {label} archived {count} low-value memories (verify with engram_review)',
  'core.decayTargetProject': 'project “{title}”',
  'core.backfillBusy': 'A backfill job is already running; pause it or wait for it to finish first',
} as const
