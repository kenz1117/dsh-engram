/**
 * 原型假数据：字段与真实回环 API（/api/engram/*）一一对应，
 * 落地 React 时可直接替换为 fetch，不改渲染结构。
 */
(function () {
  'use strict'

  var now = Date.now()
  var MIN = 60 * 1000
  var HOUR = 60 * MIN
  var DAY = 24 * HOUR

  /** 五个房间（kind 分组）的展示名与色相槽位。 */
  var ROOMS = [
    { kind: 'fact', name: '事实厅', count: 94, hue: 1 },
    { kind: 'preference', name: '偏好阁', count: 61, hue: 2 },
    { kind: 'decision', name: '决策堂', count: 78, hue: 3 },
    { kind: 'episode', name: '往事廊', count: 42, hue: 4 },
    { kind: 'skill', name: '技法坊', count: 73, hue: 5 }
  ]

  /** 记忆条目（宫殿陈展列表 + 今日待回忆）。 */
  var memories = [
    { id: '9f2c41ab7d3e', scope: 'user', kind: 'fact', status: 'active', importance: 0.82, confidence: 0.91, accessCount: 7, sourceSessionId: 'sess-3f81', sourceRound: 12, createdAt: now - 2 * HOUR, slot: { room: '事实厅', index: 4 }, content: '项目统一使用 pnpm，锁文件为 pnpm-lock.yaml，禁止混用 npm 生成 package-lock。' },
    { id: '1c88d0e5a92b', scope: 'user', kind: 'preference', status: 'active', importance: 0.74, confidence: 0.88, accessCount: 5, sourceSessionId: 'sess-3f81', sourceRound: 14, createdAt: now - 5 * HOUR, slot: { room: '偏好阁', index: 2 }, content: '用户偏好深色主题与紧凑信息密度，表格行高不要超过 36px。' },
    { id: '44ba7f01c6de', scope: 'project', kind: 'decision', status: 'active', importance: 0.9, confidence: 0.95, accessCount: 11, sourceSessionId: 'sess-90ac', sourceRound: 4, createdAt: now - 1 * DAY, slot: { room: '决策堂', index: 7 }, content: '记忆检索默认走混合道：向量不可用时降级为纯关键词，不做静默失败。' },
    { id: '7de5520b9fa1', scope: 'user', kind: 'episode', status: 'active', importance: 0.58, confidence: 0.77, accessCount: 3, sourceSessionId: 'sess-2b17', sourceRound: 22, createdAt: now - 2 * DAY, slot: { room: '往事廊', index: 11 }, content: '10 月 3 日把摄取节流阈值从 3 调到 5，低活动轮次不再入库。' },
    { id: '2ab9c73e1d40', scope: 'user', kind: 'skill', status: 'active', importance: 0.86, confidence: 0.93, accessCount: 9, sourceSessionId: 'sess-55e2', sourceRound: 8, createdAt: now - 3 * DAY, slot: { room: '技法坊', index: 1 }, content: '写 Agent Note 时先写「为什么」，再写「怎么做」；决策记录带日期与备选项。' },
    { id: '5cd1149f7b02', scope: 'user', kind: 'fact', status: 'active', importance: 0.66, confidence: 0.84, accessCount: 4, sourceSessionId: 'sess-55e2', sourceRound: 9, createdAt: now - 4 * DAY, slot: { room: '事实厅', index: 5 }, content: '本地嵌入模型缓存目录为 ~/.dsh/engram/models，首次加载约 2.4 秒。' },
    { id: '8e30b62a5c77', scope: 'project', kind: 'skill', status: 'active', importance: 0.71, confidence: 0.8, accessCount: 2, sourceSessionId: 'sess-90ac', sourceRound: 6, createdAt: now - 5 * DAY, slot: { room: '技法坊', index: 12 }, content: '排查线上白屏先看 bundle 是否 404，再确认 client 注入是否注册成功。' },
    { id: 'b6019da4e3f8', scope: 'user', kind: 'decision', status: 'active', importance: 0.77, confidence: 0.9, accessCount: 6, sourceSessionId: 'sess-3f81', sourceRound: 18, createdAt: now - 6 * DAY, slot: { room: '决策堂', index: 8 }, content: '面板文案一律走 locale 词典，禁止硬编码中文。', outcome: 'success' },
    { id: 'c47ef28501ba', scope: 'user', kind: 'preference', status: 'active', importance: 0.52, confidence: 0.7, accessCount: 1, sourceSessionId: 'sess-2b17', sourceRound: 30, createdAt: now - 8 * DAY, slot: { room: '偏好阁', index: 3 }, content: '提交信息用中文一句话说明「为什么」，不用 conventional commits 前缀。' },
    { id: 'd92a37c4be15', scope: 'user', kind: 'episode', status: 'archived', importance: 0.44, confidence: 0.65, accessCount: 2, sourceSessionId: 'sess-2b17', sourceRound: 41, createdAt: now - 11 * DAY, slot: { room: '往事廊', index: 12 }, content: '早期把门牌唯一性阈值定在 0.6，后来因为误报太多调到 0.7。' },
    { id: 'f15c8b309d6a', scope: 'user', kind: 'fact', status: 'active', importance: 0.61, confidence: 0.86, accessCount: 3, sourceSessionId: 'sess-55e2', sourceRound: 3, createdAt: now - 13 * DAY, slot: { room: '事实厅', index: 9 }, content: 'API key 写在根目录 .env，读取方是 credentials 插件；[REDACTED:openai_key] 已脱敏。' },
    { id: '3fa0c917e284', scope: 'shared', kind: 'skill', status: 'active', importance: 0.69, confidence: 0.81, accessCount: 5, sourceSessionId: 'sess-77af', sourceRound: 2, createdAt: now - 16 * DAY, slot: { room: '技法坊', index: 20 }, content: '跨仓改动先在本仓跑一次 typecheck，再去目标仓复验，避免假绿。', outcome: 'failure' }
  ]

  /** 今日待回忆：只给线索（坐标 / 门牌 / 逾期天数），正文要「揭示」才给。 */
  var due = [
    { id: '9f2c41ab7d3e', kind: 'fact', slot: { room: '事实厅', index: 4 }, caption: '包管理器与锁文件', nextReviewAt: now - 2 * DAY, overdueDays: 2, reps: 4 },
    { id: '44ba7f01c6de', kind: 'decision', slot: { room: '决策堂', index: 7 }, caption: '检索降级策略', nextReviewAt: now - DAY, overdueDays: 1, reps: 2 },
    { id: '2ab9c73e1d40', kind: 'skill', slot: { room: '技法坊', index: 1 }, caption: '写作顺序：先为什么', nextReviewAt: now, overdueDays: 0, reps: 1 },
    { id: 'b6019da4e3f8', kind: 'decision', slot: { room: '决策堂', index: 8 }, caption: null, nextReviewAt: now, overdueDays: 0, reps: 0 }
  ]

  var data = {
    scope: 'user',
    /** 三宫格规模（stats API 的 parts）。 */
    stats: {
      user: { total: 348, active: 291, archived: 41, forgotten: 16, redacted: 7, signalRatio: 0.836 },
      project: { total: 126, active: 108, archived: 12, forgotten: 6, redacted: 2, signalRatio: 0.857 },
      shared: { total: 54, active: 41, archived: 9, forgotten: 4, redacted: 1, signalRatio: 0.759 }
    },
    /** 近 7 天活动（telemetry API）。 */
    telemetry: {
      windowDays: 7,
      counts: { writes: 24, forgets: 3, ingestRequests: 31, ingestDones: 27, distillRequests: 4, consolidations: 2 },
      /** 迷你柱状图用的逐日写入量（原型补充字段）。 */
      daily: [
        { day: '周四', writes: 3, ingests: 4 },
        { day: '周五', writes: 5, ingests: 6 },
        { day: '周六', writes: 1, ingests: 2 },
        { day: '周日', writes: 2, ingests: 3 },
        { day: '周一', writes: 6, ingests: 7 },
        { day: '周二', writes: 4, ingests: 5 },
        { day: '周三', writes: 3, ingests: 4 }
      ]
    },
    /** 健康分（health API）。 */
    health: {
      overall: 86,
      parts: [
        { scope: 'user', score: 88, signal: 0.84, activeRatio: 0.84, edgeCount: 214, redacted: 7, archivedRatio: 0.12 },
        { scope: 'project', score: 84, signal: 0.86, activeRatio: 0.86, edgeCount: 78, redacted: 2, archivedRatio: 0.1 },
        { scope: 'shared', score: 79, signal: 0.76, activeRatio: 0.76, edgeCount: 22, redacted: 1, archivedRatio: 0.17 }
      ],
      evaluatedAt: now - 4 * MIN
    },
    rooms: ROOMS,
    memories: memories,
    due: due,
    /** 翻新清单（refurb API）。 */
    refurb: {
      count: 3,
      suggestions: [
        { action: 'merge', primaryId: 'c47ef28501ba', candidates: ['1c88d0e5a92b'], reason: '两条偏好都在讲「提交与写作习惯」，语义相似度 0.83，建议合并为一条高层规律。', confidence: 0.83 },
        { action: 'review', primaryId: 'd92a37c4be15', candidates: [], reason: '门牌唯一性阈值的历史记录与当前常量不一致，需要确认哪条是现行约定。', confidence: 0.71 },
        { action: 'demote', primaryId: '5cd1149f7b02', candidates: [], reason: '嵌入模型缓存路径已迁移，该条 60 天未被命中，建议降级归档保留考古价值。', confidence: 0.68 }
      ]
    },
    /** 走廊鸟瞰（corridor API）：节点 + 关系边，坐标由原型固定布局给出。 */
    corridor: {
      nodes: [
        { id: '9f2c41ab7d3e', kind: 'fact', title: '包管理器与锁文件', x: 0.5, y: 0.16, r: 13 },
        { id: '44ba7f01c6de', kind: 'decision', title: '检索降级策略', x: 0.24, y: 0.42, r: 15 },
        { id: '2ab9c73e1d40', kind: 'skill', title: '写作顺序：先为什么', x: 0.76, y: 0.38, r: 13 },
        { id: '1c88d0e5a92b', kind: 'preference', title: '深色与紧凑密度', x: 0.16, y: 0.74, r: 11 },
        { id: '7de5520b9fa1', kind: 'episode', title: '节流阈值调整', x: 0.45, y: 0.62, r: 10 },
        { id: 'b6019da4e3f8', kind: 'decision', title: '文案走词典', x: 0.6, y: 0.84, r: 12 },
        { id: '5cd1149f7b02', kind: 'fact', title: '嵌入缓存路径', x: 0.86, y: 0.66, r: 9 }
      ],
      edges: [
        { from: '9f2c41ab7d3e', to: '44ba7f01c6de', type: 'related' },
        { from: '44ba7f01c6de', to: 'b6019da4e3f8', type: 'related' },
        { from: '44ba7f01c6de', to: '7de5520b9fa1', type: 'supersedes' },
        { from: '2ab9c73e1d40', to: 'b6019da4e3f8', type: 'related' },
        { from: '1c88d0e5a92b', to: '2ab9c73e1d40', type: 'related' },
        { from: '5cd1149f7b02', to: '9f2c41ab7d3e', type: 'contradicts' }
      ]
    },
    /** 入殿导航（tour-proposal API）。 */
    tourProposal: {
      greeting: '今天有 4 条记忆到期。先走固定路线复述一遍事实厅，再看来往事廊——顺序本身就是线索。',
      activeCount: 291,
      empty: false,
      suggestedStops: [
        { id: '9f2c41ab7d3e', kind: '事实厅', content: '项目统一使用 pnpm，锁文件为 pnpm-lock.yaml…' },
        { id: '44ba7f01c6de', kind: '决策堂', content: '记忆检索默认走混合道：向量不可用时降级为纯关键词…' },
        { id: '2ab9c73e1d40', kind: '技法坊', content: '写 Agent Note 时先写「为什么」，再写「怎么做」…' }
      ]
    },
    /** 管家日志（activity API）：两条库合并倒序。 */
    activity: [
      { at: now - 2 * MIN, op: 'ingest-done', scope: 'user', detail: JSON.stringify({ round: 12, mode: 'light', userText: '把面板的日报条重排一下，数字不要平铺' }) },
      { at: now - 4 * MIN, op: 'write', scope: 'user', detail: JSON.stringify({ kind: 'fact', scope: 'user' }) },
      { at: now - 9 * MIN, op: 'search-rewrite-request', scope: 'user', detail: JSON.stringify({ query: '面板排版', queries: ['面板排版', '日报条布局', '信息层级'] }) },
      { at: now - 26 * MIN, op: 'ingest-request', scope: 'user', detail: JSON.stringify({ round: 12, mode: 'light', userText: '把面板的日报条重排一下' }) },
      { at: now - 52 * MIN, op: 'outcome-report', scope: 'project', detail: 'success' },
      { at: now - 2 * HOUR, op: 'update', scope: 'user', detail: JSON.stringify({ kind: 'decision' }) },
      { at: now - 3 * HOUR, op: 'compress-request', scope: 'user', detail: JSON.stringify({ count: 6 }) },
      { at: now - 5 * HOUR, op: 'distill-request', scope: 'user', detail: JSON.stringify({ kind: 'preference' }) },
      { at: now - 8 * HOUR, op: 'forget', scope: 'user', detail: '翻新清单降级' },
      { at: now - 1 * DAY, op: 'restore', scope: 'user', detail: null },
      { at: now - 1 * DAY - 3 * HOUR, op: 'decay', scope: 'user', detail: JSON.stringify({ kind: 'episode' }) },
      { at: now - 2 * DAY, op: 'superseded', scope: 'project', detail: JSON.stringify({ supersededBy: '3fa0c917e284' }) }
    ],
    /** 历史回填（history-backfill API）估算 + 运行进度。 */
    backfill: {
      estimate: {
        candidates: 13,
        eligibleTurns: 55,
        pendingTurns: 55,
        alreadyIngested: 0,
        truncated: false,
        skipped: { subagent: 4, seeded: 2, noCwd: 1, tooOld: 18, unreadable: 0 }
      },
      status: {
        state: 'running',
        sessionsTotal: 13,
        sessionsDone: 9,
        turnsPlanned: 55,
        turnsDone: 37,
        memoriesWritten: 18,
        turnsSkipped: 15,
        turnsFailed: 3,
        skipReasons: { 'low-activity': 9, chitchat: 4, 'already-ingested': 2 },
        currentSession: 'sess-3f81'
      },
      failures: [
        { sessionId: 'sess-2b17', turn: 4, reason: 'provider "zai" has no configured model "glm-4.5-air"' }
      ],
      modelOptions: [
        { provider: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'deepseek-v4' }, { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }] },
        { provider: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'gpt-5' }] }
      ]
    }
  }

  /** 文案对照表：原型视图暂时内联中文，此表给出落地 React 时应写入 locales.ts 的键名与中文值。 */
  data.text = {
    headerTitle: '记忆库',
    headerSubtitle: '记忆宫殿 · 位置当索引，路线定顺序',
    scopeUser: '私人',
    scopeProject: '项目',
    scopeShared: '共享',
    refresh: '刷新',
    export: '导出',
    dueBadge: '今日待回忆',
    navToday: '今日',
    navPalace: '宫殿',
    navTour: '巡游',
    navLog: '日志',
    navBackfill: '回填',
    todayTitle: '今日速览',
    todayLead: '先回忆，再整理，最后才铺开看',
    memories: '记忆',
    active: '开放',
    forgotten: '闭馆',
    signal: '清晰度',
    writes7d: '近 7 天写入',
    ingests7d: '摄取',
    health: '健康分',
    reviewQueue: '今日待回忆',
    reviewHint: '只给线索：先在心里复述，再揭示核对',
    reveal: '揭示正文',
    gradeRemember: '记得',
    gradeVague: '模糊',
    gradeForgot: '忘了',
    overdue: '逾期 {n} 天',
    dueToday: '今日到期',
    noPlacard: '未挂门牌',
    refurb: '待翻新',
    refurbRun: '重新扫描',
    execute: '执行',
    tourProposal: '入殿导航',
    healthTitle: '宫殿健康分',
    corridor: '走廊鸟瞰',
    bench: '检索实验台',
    activity: '管家日志',
    backfillTitle: '历史回填',
    palaceTitle: '宫殿陈展',
    listSearch: '搜索正文…',
    sortTime: '按时间',
    sortTour: '按巡游路线',
    allStatuses: '全部状态',
    allKinds: '全部房间',
    statusActive: '开放',
    statusArchived: '归档',
    statusForgotten: '已闭馆',
    importance: '重要性',
    confidence: '置信',
    accessed: '命中 {n}',
    detail: '详情',
    edit: '编辑',
    forget: '遗忘',
    restore: '恢复',
    prevPage: '上一页',
    nextPage: '下一页',
    empty: '这里还没有记忆',
    loading: '读取中…'
  }

  window.EngramMock = data
})()
