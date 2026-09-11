/**
 * 五个视图的渲染：纯函数（state -> HTML 字符串），事件由 app.js 委托处理。
 * 落地 React 时每个 Views.* 对应一个页组件，HTML 结构可 1:1 映射为 JSX。
 */
(function () {
  'use strict'

  var M = window.EngramMock

  /* ---------- 工具 ---------- */
  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }

  function rel(ms) {
    var diff = Date.now() - ms
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
    if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前'
    return new Date(ms).toISOString().slice(0, 10)
  }

  function abs(ms) { return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) }

  /** kind 数据值 → 房间名（存储层英文枚举，显示层中文）。 */
  var ROOM_NAME = {}
  M.rooms.forEach(function (room, index) { ROOM_NAME[room.kind] = { name: room.name, slot: index + 1 } })
  function roomName(kind) { return ROOM_NAME[kind] ? ROOM_NAME[kind].name : kind }
  function roomSlot(kind) { return ROOM_NAME[kind] ? ROOM_NAME[kind].slot : 1 }

  function roomPill(kind) {
    return '<span class="pill room" style="--room: var(--room-' + esc(kind) + ')">' + esc(roomName(kind)) + '</span>'
  }

  var STATUS_CLASS = { active: 'status-active', archived: 'status-archived', forgotten: 'status-forgotten' }
  var STATUS_TEXT = { active: '开放', archived: '归档', forgotten: '已闭馆' }
  function statusPill(status) {
    return '<span class="pill ' + STATUS_CLASS[status] + '">' + STATUS_TEXT[status] + '</span>'
  }

  function metric(label, value, tail, hero) {
    return '<div class="metric' + (hero ? ' hero' : '') + '">' +
      '<span class="metricLabel">' + esc(label) + '</span>' +
      '<b class="metricValue num">' + esc(value) + '</b>' +
      (tail ? '<span class="metricTail">' + esc(tail) + '</span>' : '') +
      '</div>'
  }

  /** 健康分环：SVG 描边进度。 */
  function ring(score) {
    var r = 24
    var c = 2 * Math.PI * r
    var filled = c * (score / 100)
    var tone = score >= 80 ? 'var(--dsw-alias-state-success-primary)' : score >= 50 ? 'var(--dsw-alias-state-warning-primary)' : 'var(--dsw-alias-state-error-primary)'
    return '<div class="ring"><svg width="56" height="56" viewBox="0 0 56 56">' +
      '<circle cx="28" cy="28" r="' + r + '" fill="none" stroke="var(--dsw-alias-border-l2)" stroke-width="4"/>' +
      '<circle cx="28" cy="28" r="' + r + '" fill="none" stroke="' + tone + '" stroke-width="4" stroke-linecap="round" ' +
      'stroke-dasharray="' + filled.toFixed(1) + ' ' + c.toFixed(1) + '"/></svg>' +
      '<b class="num">' + score + '</b></div>'
  }

  function sectionHead(title, hint, action) {
    return '<div class="sectionHead"><h2 class="sectionTitle">' + esc(title) + '</h2>' +
      (hint ? '<span class="sectionHint">' + esc(hint) + '</span>' : '') +
      (action || '') + '</div>'
  }

  function memOps(id) {
    return '<div class="memOps">' +
      '<button type="button" class="button sm" data-act="detail" data-id="' + esc(id) + '">详情</button>' +
      '<button type="button" class="button sm" data-act="edit" data-id="' + esc(id) + '">编辑</button>' +
      '<button type="button" class="button sm danger" data-act="forget" data-id="' + esc(id) + '">遗忘</button>' +
      '</div>'
  }

  /* ---------- 今日 ---------- */
  function today(state) {
    var stats = M.stats[state.scope]
    var tele = M.telemetry
    var health = M.health
    var maxWrites = Math.max.apply(null, tele.daily.map(function (d) { return d.writes }))

    var hero =
      '<section class="hero">' +
        '<div class="heroMetrics">' +
          metric('记忆', stats.total, '近 7 天 +' + tele.counts.writes, true) +
          metric('开放', stats.active, '闭馆 ' + stats.forgotten) +
          metric('清晰度', Math.round(stats.signalRatio * 100) + '%', '脱敏 ' + stats.redacted) +
        '</div>' +
        '<div class="heroChart">' +
          '<span class="metricLabel">近 7 天写入</span>' +
          '<div class="spark">' + tele.daily.map(function (d) {
            var pct = Math.max(8, Math.round(d.writes / maxWrites * 100))
            return '<span class="sparkBar" style="height:' + pct + '%" title="' + esc(d.day) + ' 写入 ' + d.writes + '"></span>'
          }).join('') + '</div>' +
          '<div class="sparkAxis">' + tele.daily.map(function (d) { return '<span>' + esc(d.day.slice(1)) + '</span>' }).join('') + '</div>' +
        '</div>' +
        '<div class="heroHealth">' + ring(health.overall) +
          '<div class="metric"><span class="metricLabel">健康分</span>' +
          '<span class="metricTail">评估于 ' + esc(rel(health.evaluatedAt)) + '</span>' +
          '<span class="metricTail">' + tele.counts.ingestRequests + ' 次摄取 · ' + tele.counts.consolidations + ' 次整理</span></div>' +
        '</div>' +
      '</section>'

    var dueItems = M.due.filter(function (item) { return !state.today.done[item.id] })
    var review =
      '<section class="section" id="review-section">' +
        sectionHead('今日待回忆', '只给线索：先在心里复述，再揭示核对', '<button type="button" class="button sm" data-act="goto-palace">去宫殿</button>') +
        '<div class="card">' +
          (dueItems.length === 0
            ? '<div class="empty">今天的复习都完成了。明天再走一遍固定路线。</div>'
            : '<ul class="reviewList">' + dueItems.map(function (item) {
              var revealed = state.today.revealed[item.id]
              var memory = M.memories.filter(function (m) { return m.id === item.id })[0] || { content: '（原型数据缺该条正文）' }
              return '<li class="reviewItem">' +
                '<div class="reviewCue">' + roomPill(item.kind) +
                  '<span class="reviewSlot">' + esc(item.slot.room) + '#' + item.slot.index + '</span>' +
                  '<span class="reviewCaption">' + esc(item.caption || '未挂门牌') + '</span>' +
                  '<span class="reviewOverdue' + (item.overdueDays > 0 ? '' : ' today') + '">' +
                    (item.overdueDays > 0 ? '逾期 ' + item.overdueDays + ' 天' : '今日到期') + '</span>' +
                '</div>' +
                (revealed
                  ? '<div class="reviewGrades">' +
                      '<button type="button" class="button primary" data-act="grade" data-id="' + esc(item.id) + '" data-grade="5">记得</button>' +
                      '<button type="button" class="button" data-act="grade" data-id="' + esc(item.id) + '" data-grade="3">模糊</button>' +
                      '<button type="button" class="button" data-act="grade" data-id="' + esc(item.id) + '" data-grade="1">忘了</button>' +
                    '</div>'
                  : '<button type="button" class="button" data-act="reveal" data-id="' + esc(item.id) + '">揭示正文</button>') +
                (revealed ? '<div class="reviewReveal">' + esc(memory.content) + '</div>' : '') +
                '</li>'
            }).join('') + '</ul>') +
        '</div>' +
      '</section>'

    var refurb =
      '<section class="section">' +
        sectionHead('待翻新', M.refurb.count + ' 条建议', '<button type="button" class="button sm" data-act="refurb-rescan">重新扫描</button>') +
        '<div class="card"><ul>' + M.refurb.suggestions.map(function (s) {
          var label = { merge: '合并', demote: '降级', review: '复核', split: '拆分' }[s.action]
          return '<li class="refurbItem">' +
            '<button type="button" class="chip" data-act="detail" data-id="' + esc(s.primaryId) + '">' + esc(label) + '</button>' +
            '<span class="refurbReason">' + esc(s.reason) + '</span>' +
            '<span class="refurbConfidence">' + Math.round(s.confidence * 100) + '%</span>' +
            '<button type="button" class="button sm" data-act="refurb-run" data-id="' + esc(s.primaryId) + '" data-kind="' + esc(s.action) + '">执行</button>' +
            '</li>'
        }).join('') + '</ul></div>' +
      '</section>'

    var stops =
      '<section class="section">' +
        sectionHead('入殿导航', '按房间聚焦开场建议') +
        '<div class="card">' +
          '<div class="focusRow">' + ['', 'fact', 'preference', 'decision', 'episode', 'skill'].map(function (kind) {
            var label = kind === '' ? '全部' : roomName(kind)
            return '<button type="button" class="chip' + (state.tour.focusKind === kind ? ' on' : '') +
              '" data-act="focus" data-kind="' + esc(kind) + '">' + esc(label) + '</button>'
          }).join('') + '</div>' +
          '<p class="tourGreeting">' + esc(M.tourProposal.greeting) + '</p>' +
          '<ul>' + M.tourProposal.suggestedStops.map(function (stop, index) {
            return '<li><button type="button" class="tourStop" data-act="detail" data-id="' + esc(stop.id) + '">' +
              '<span class="tourStopIndex">' + (index + 1) + '</span>' +
              '<span class="grow"><span class="tourStopText">' + esc(stop.content) + '</span></span>' +
              '</button></li>'
          }).join('') + '</ul>' +
        '</div>' +
      '</section>'

    var healthCard =
      '<section class="section">' +
        sectionHead('宫殿健康分', '信号 / 归档 / 脱敏综合') +
        '<div class="card">' +
          '<div class="row" style="gap:var(--space-4);align-items:flex-end;margin-bottom:var(--space-4)">' +
            '<b class="num" style="font-size:var(--fs-metric)">' + health.overall + '</b>' +
            '<span class="muted">/ 100</span>' +
            '<span class="grow"></span>' +
            '<span class="muted">关系边 ' + health.parts.reduce(function (sum, p) { return sum + p.edgeCount }, 0) + '</span>' +
          '</div>' +
          health.parts.map(function (part) {
            var scopeLabel = { user: '私人', project: '项目', shared: '共享' }[part.scope]
            return '<div style="margin-bottom:var(--space-3)">' +
              '<div class="row" style="justify-content:space-between;margin-bottom:4px">' +
                '<span class="muted">' + esc(scopeLabel) + '</span><b class="num">' + part.score + '</b></div>' +
              '<div class="bar"><i style="width:' + part.score + '%"></i></div></div>'
          }).join('') +
        '</div>' +
      '</section>'

    var rooms =
      '<section class="section">' +
        sectionHead('房间目录', '每间容量 9 桩位后开新间') +
        '<div class="card">' + M.rooms.map(function (room) {
          return '<div class="roomRow">' +
            '<span class="roomSwatch" style="--room: var(--room-' + esc(room.kind) + ')"></span>' +
            '<span>' + esc(room.name) + '</span>' +
            '<b class="num muted">' + room.count + '</b></div>'
        }).join('') + '</div>' +
      '</section>'

    return hero + '<div class="grid2"><div class="stack">' + review + refurb + '</div>' +
      '<div class="stack">' + healthCard + rooms + stops + '</div></div>'
  }

  /* ---------- 宫殿 ---------- */
  function palaceRows(state) {
    var p = state.palace
    var rows = M.memories.filter(function (m) {
      if (p.status !== 'all' && m.status !== p.status) return false
      if (p.kind !== 'all' && m.kind !== p.kind) return false
      if (p.q !== '' && m.content.toLowerCase().indexOf(p.q.toLowerCase()) < 0) return false
      return true
    })
    rows.sort(function (a, b) {
      if (p.sort === 'tour') {
        var roomDiff = roomSlot(a.kind) - roomSlot(b.kind)
        if (roomDiff !== 0) return roomDiff
        return (a.slot ? a.slot.index : 99) - (b.slot ? b.slot.index : 99)
      }
      return b.createdAt - a.createdAt
    })
    return rows
  }

  function palace(state) {
    var p = state.palace
    var rows = palaceRows(state)
    var selected = Object.keys(p.selected).filter(function (id) { return p.selected[id] }).length

    var toolbar =
      '<div class="toolbar">' +
        '<div class="segGroup">' + [['all', '全部状态'], ['active', '开放'], ['archived', '归档'], ['forgotten', '已闭馆']].map(function (pair) {
          return '<button type="button" class="segItem' + (p.status === pair[0] ? ' on' : '') + '" data-act="f-status" data-value="' + pair[0] + '">' + pair[1] + '</button>'
        }).join('') + '</div>' +
        '<div class="segGroup">' + [['all', '全部房间']].concat(M.rooms.map(function (room) { return [room.kind, room.name] })).map(function (pair) {
          return '<button type="button" class="segItem' + (p.kind === pair[0] ? ' on' : '') + '" data-act="f-kind" data-value="' + esc(pair[0]) + '">' + esc(pair[1]) + '</button>'
        }).join('') + '</div>' +
        '<div class="segGroup">' + [['time', '按时间'], ['tour', '按巡游路线']].map(function (pair) {
          return '<button type="button" class="segItem' + (p.sort === pair[0] ? ' on' : '') + '" data-act="f-sort" data-value="' + pair[0] + '">' + pair[1] + '</button>'
        }).join('') + '</div>' +
        '<input class="input grow" placeholder="搜索正文…" value="' + esc(p.q) + '" data-act="f-q">' +
      '</div>'

    var batch = selected === 0 ? '' :
      '<div class="batchBar"><span>已选 ' + selected + ' 条</span>' +
      '<button type="button" class="button sm" data-act="batch-restore">恢复</button>' +
      '<button type="button" class="button sm danger" data-act="batch-forget">遗忘</button>' +
      '<button type="button" class="button sm ghost" data-act="batch-clear">取消选择</button></div>'

    var list = rows.length === 0
      ? '<div class="empty">这里还没有记忆。换个房间或清空搜索词试试。</div>'
      : '<div class="rows">' + rows.map(function (m) {
        return '<div class="memRow' + (p.selected[m.id] ? ' sel' : '') + '" data-id="' + esc(m.id) + '">' +
          '<input type="checkbox" class="memCheck"' + (p.selected[m.id] ? ' checked' : '') + ' data-act="select" data-id="' + esc(m.id) + '" aria-label="选择该条">' +
          '<div>' +
            '<div class="memTags">' + statusPill(m.status) + roomPill(m.kind) +
              (m.slot ? '<span class="pill coord">' + esc(m.slot.room) + '#' + m.slot.index + '</span>' : '') +
              (m.content.indexOf('[REDACTED:') >= 0 ? '<span class="pill redacted">已脱敏</span>' : '') +
              (m.outcome ? '<span class="pill outcome-' + m.outcome + '">' + (m.outcome === 'success' ? '回报有效' : '回报无效') + '</span>' : '') +
              '<span class="pill" style="margin-left:auto" title="' + esc(abs(m.createdAt)) + '">' + esc(rel(m.createdAt)) + '</span>' +
            '</div>' +
            '<div class="memContent">' + esc(m.content) + '</div>' +
            '<div class="memMeta"><span>重要性 ' + m.importance.toFixed(2) + '</span><span>置信 ' + m.confidence.toFixed(2) + '</span>' +
              '<span>命中 ' + m.accessCount + '</span><span>来源 ' + esc(m.sourceSessionId || '—') + (m.sourceRound ? ' · 第 ' + m.sourceRound + ' 轮' : '') + '</span></div>' +
          '</div>' + memOps(m.id) +
          '</div>'
      }).join('') + '</div>'

    var pager = '<div class="pager"><button type="button" class="button sm" data-act="page-prev">‹</button>' +
      '<span>第 1 / 1 页 · 共 ' + rows.length + ' 条</span>' +
      '<button type="button" class="button sm" data-act="page-next">›</button></div>'

    return sectionHead('宫殿陈展', '按房间与状态筛选；巡游路线序即固定路线') + toolbar + batch + list + pager
  }

  /* ---------- 巡游 ---------- */
  function tour(state) {
    var c = M.corridor
    var width = 1000
    var height = 300
    var edges = c.edges.map(function (edge) {
      var from = c.nodes.filter(function (n) { return n.id === edge.from })[0]
      var to = c.nodes.filter(function (n) { return n.id === edge.to })[0]
      if (!from || !to) return ''
      var stroke = edge.type === 'contradicts' ? 'var(--dsw-alias-state-error-primary)'
        : edge.type === 'supersedes' ? 'var(--dsw-alias-state-warning-primary)' : 'var(--dsw-alias-border-l2)'
      return '<line x1="' + (from.x * width) + '" y1="' + (from.y * height) + '" x2="' + (to.x * width) + '" y2="' + (to.y * height) +
        '" stroke="' + stroke + '" stroke-width="1.4" stroke-dasharray="' + (edge.type === 'related' ? '0' : '4 4') + '"/>'
    }).join('')

    var corridor =
      '<section class="section">' +
        sectionHead('走廊鸟瞰', c.nodes.length + ' 个桩位 · ' + c.edges.length + ' 条关系边') +
        '<div class="corridor">' +
          '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' + edges + '</svg>' +
          c.nodes.map(function (node) {
            return '<button type="button" class="node" data-act="detail" data-id="' + esc(node.id) + '" ' +
              'style="left:' + (node.x * 100) + '%;top:' + (node.y * 100) + '%;--room: var(--room-' + esc(node.kind) + ')" ' +
              'title="' + esc(node.title) + '（点击查看）"><i></i>' + esc(node.title) + '</button>'
          }).join('') +
        '</div>' +
        '<div class="legend">' +
          '<span><i style="background:var(--room-fact)"></i>节点色 = 房间</span>' +
          '<span><i style="background:var(--dsw-alias-border-l2)"></i>实线 = 关联</span>' +
          '<span><i style="background:var(--dsw-alias-state-warning-primary)"></i>虚线 = 取代 / 矛盾</span>' +
        '</div>' +
      '</section>'

    var bench = state.tour.benchHits === null ? '' :
      '<div style="margin-top:var(--space-3)">' + state.tour.benchHits.map(function (hit) {
        return '<div class="benchRow">' +
          '<div class="benchHead"><span class="viaChip">' + esc(hit.via) + '</span>' + roomPill(hit.kind) +
            '<span class="benchScore">' + hit.score.toFixed(4) + '</span></div>' +
          '<div class="benchContent">' + esc(hit.content) + '</div>' +
          '<small class="muted mono">' + esc(hit.id) + '</small></div>'
      }).join('') + '</div>'

    var retrieve =
      '<section class="section">' +
        sectionHead('检索实验台', '调参看命中：混合道分数与命中来源') +
        '<div class="card">' +
          '<div class="row">' +
            '<input class="input grow" placeholder="输入查询词，回车检索…" value="' + esc(state.tour.benchQ) + '" data-act="bench-q">' +
            '<select class="input" data-act="bench-scope">' +
              ['all', 'user', 'project', 'shared'].map(function (value) {
                var label = { all: '全部作用域', user: '私人', project: '项目', shared: '共享' }[value]
                return '<option value="' + value + '">' + label + '</option>'
              }).join('') + '</select>' +
            '<button type="button" class="button primary" data-act="bench-run">检索</button>' +
          '</div>' + bench +
        '</div>' +
      '</section>'

    var walk =
      '<section class="section">' +
        sectionHead('试走一遍', '固定路线逐站复述，顺序即线索') +
        '<div class="card"><p class="tourGreeting">' + esc(M.tourProposal.greeting) + '</p>' +
          '<ul>' + M.tourProposal.suggestedStops.map(function (stop, index) {
            return '<li><button type="button" class="tourStop" data-act="detail" data-id="' + esc(stop.id) + '">' +
              '<span class="tourStopIndex">' + (index + 1) + '</span>' +
              '<span class="grow"><span class="tourStopText">' + esc(stop.content) + '</span></span></button></li>'
          }).join('') + '</ul></div>' +
      '</section>'

    return '<div class="stack">' + corridor + walk + retrieve + '</div>'
  }

  /* ---------- 日志 ---------- */
  var LOG_GROUPS = {
    all: null,
    write: ['write', 'update', 'superseded', 'restore', 'forget', 'decay', 'outcome-report'],
    ingest: ['ingest-request', 'ingest-done'],
    retrieve: ['search-rewrite-request', 'compress-request'],
    organize: ['distill-request', 'consolidate']
  }
  var OP_TEXT = {
    write: '写入', update: '修正', superseded: '取代', restore: '恢复', forget: '遗忘', decay: '衰减',
    'outcome-report': '效果回报', 'ingest-request': '摄取请求', 'ingest-done': '摄取完成',
    'search-rewrite-request': '检索改写', 'compress-request': '画像压缩', 'distill-request': '蒸馏请求', consolidate: '合并整理'
  }

  /** 日志详情摘要：JSON 详情解析出可读短语，否则原文截断。 */
  function detailText(row) {
    if (row.detail === null) return ''
    try {
      var parsed = JSON.parse(row.detail)
      if (typeof parsed.round === 'number') return '第 ' + parsed.round + ' 轮 · ' + String(parsed.userText || '').slice(0, 40)
      if (parsed.query) return '「' + parsed.query + '」→ ' + (parsed.queries || []).length + ' 个改写查询'
      if (typeof parsed.count === 'number') return parsed.count + ' 条画像条目压缩'
      if (parsed.supersededBy) return '被 ' + parsed.supersededBy + ' 取代'
      if (parsed.kind) return '房间 · ' + roomName(parsed.kind)
    } catch (err) {
      // 非 JSON（outcome 值等）：走末尾原样截断。
    }
    return String(row.detail).slice(0, 60)
  }

  function log(state) {
    var allow = LOG_GROUPS[state.log.filter]
    var rows = M.activity.filter(function (row) { return allow === null || allow.indexOf(row.op) >= 0 })
    var tele = M.telemetry

    var summary =
      '<section class="grid3" style="margin-bottom:var(--space-5)">' +
        [['写入', tele.counts.writes], ['摄取完成', tele.counts.ingestDones], ['整理', tele.counts.consolidations]].map(function (pair) {
          return '<div class="card tint">' + metric(pair[0], pair[1], '近 7 天') + '</div>'
        }).join('') + '</section>'

    var filters =
      '<div class="toolbar"><div class="segGroup">' +
      [['all', '全部'], ['write', '写入类'], ['ingest', '摄取'], ['retrieve', '检索'], ['organize', '整理']].map(function (pair) {
        return '<button type="button" class="segItem' + (state.log.filter === pair[0] ? ' on' : '') +
          '" data-act="log-filter" data-value="' + pair[0] + '">' + pair[1] + '</button>'
      }).join('') + '</div>' +
      '<span class="grow"></span><span class="sectionHint">' + rows.length + ' 条 · 两库合并倒序</span></div>'

    var rowsHtml = '<div>' + rows.map(function (row) {
      return '<div class="logRow">' +
        '<span class="logTime">' + esc(rel(row.at)) + '</span>' +
        '<span class="logOp">' + esc(OP_TEXT[row.op] || row.op) + '</span>' +
        '<span class="logScope">' + (row.scope === 'user' ? '私人' : '项目') + '</span>' +
        '<span class="logDetail" title="' + esc(row.detail || '') + '">' + esc(detailText(row)) + '</span>' +
        '</div>'
    }).join('') + '</div>'

    return sectionHead('管家日志', '写入 / 摄取 / 检索 / 整理全过程可审计') +
      summary + filters + '<div class="card">' + rowsHtml + '</div>'
  }

  /* ---------- 回填 ---------- */
  function backfill(state) {
    var b = state.backfill
    var est = M.backfill.estimate
    var rules =
      '<section class="section">' +
        sectionHead('导入规则', '先估算（零成本），再决定是否执行') +
        '<div class="card"><div class="fields">' +
          '<label class="field"><span class="fieldLabel">时间窗（天）</span>' +
            '<input class="input" type="number" value="' + b.days + '" data-act="bf-days"></label>' +
          '<label class="field"><span class="fieldLabel">单会话轮数上限</span>' +
            '<input class="input" type="number" value="' + b.maxTurnsPerSession + '" data-act="bf-turns"></label>' +
          '<label class="field"><span class="fieldLabel">总轮数上限</span>' +
            '<input class="input" type="number" value="' + b.maxTotalTurns + '" data-act="bf-total"></label>' +
          '<label class="field"><span class="fieldLabel">辅助模型</span>' +
            '<select class="input"><option>自动（用当前在用的模型）</option>' +
            M.backfill.modelOptions.map(function (provider) {
              return provider.models.map(function (model) {
                return '<option>' + esc(provider.name + ' · ' + model.name) + '</option>'
              }).join('')
            }).join('') + '</select></label>' +
        '</div><div class="divider"></div><div class="row" style="gap:var(--space-5);flex-wrap:wrap">' +
          '<label class="switch"><input type="checkbox"' + (b.includeSubagents ? ' checked' : '') + ' data-act="bf-sub">包含子代理会话</label>' +
          '<label class="switch"><input type="checkbox"' + (b.includeSeeded ? ' checked' : '') + ' data-act="bf-seeded">包含种子会话</label>' +
          '<label class="switch"><input type="checkbox"' + (b.includeNoCwd ? ' checked' : '') + ' data-act="bf-nocwd">包含无 cwd 会话</label>' +
        '</div></div>' +
      '</section>'

    var estimate =
      '<section class="section">' +
        sectionHead('估算', '只查已存在的库，不创建空库') +
        '<div class="estGrid">' +
          metric('候选会话', est.candidates) + metric('可回填轮次', est.eligibleTurns) +
          metric('待处理轮次', est.pendingTurns) + metric('已摄取', est.alreadyIngested) +
        '</div>' +
        '<div class="sectionHint" style="margin-top:var(--space-2)">跳过：过期 ' + est.skipped.tooOld +
          ' · 子代理 ' + est.skipped.subagent + ' · 种子 ' + est.skipped.seeded + ' · 无 cwd ' + est.skipped.noCwd + '</div>' +
      '</section>'

    var status = M.backfill.status
    var pct = Math.round(status.turnsDone / status.turnsPlanned * 100)
    var run =
      '<section class="section">' +
        sectionHead('执行', status.state === 'running' ? '运行中 · 可暂停续做' : '已完成') +
        '<div class="card">' +
          '<div class="row" style="justify-content:space-between;margin-bottom:var(--space-2)">' +
            '<span>轮次 ' + status.turnsDone + ' / ' + status.turnsPlanned +
            '　会话 ' + status.sessionsDone + ' / ' + status.sessionsTotal + '</span>' +
            '<span class="muted">写入 ' + status.memoriesWritten + ' 条 · 跳过 ' + status.turnsSkipped + ' 轮 · 失败 ' + status.turnsFailed + ' 轮</span></div>' +
          '<div class="progress"><i style="width:' + pct + '%"></i></div>' +
          '<div class="sectionHint" style="margin-top:var(--space-3)">跳过原因：' +
            Object.keys(status.skipReasons).map(function (reason) {
              var text = { 'low-activity': '活动太少', chitchat: '闲聊', 'already-ingested': '已摄取' }[reason] || reason
              return text + ' ' + status.skipReasons[reason]
            }).join(' · ') + '</div>' +
          '<div class="divider"></div>' +
          '<div class="sectionHint" style="margin-bottom:var(--space-2)">失败明细（路由不可用时换辅助模型重跑）</div>' +
          M.backfill.failures.map(function (fail) {
            return '<div class="failItem"><span class="mono muted">' + esc(fail.sessionId) + ' · 第 ' + fail.turn + ' 轮</span>' +
              '<span>' + esc(fail.reason) + '</span></div>'
          }).join('') +
          '<div class="row" style="margin-top:var(--space-4)">' +
            '<button type="button" class="button primary" data-act="bf-start">开始回填</button>' +
            '<button type="button" class="button" data-act="bf-pause">暂停</button>' +
          '</div>' +
        '</div>' +
      '</section>'

    return rules + estimate + run
  }

  window.EngramViews = { today: today, palace: palace, tour: tour, log: log, backfill: backfill }
})()
