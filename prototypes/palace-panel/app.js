/**
 * 外壳行为：导航路由、全局 scope、事件委托、详情抽屉、Toast、回填进度模拟。
 * 只读写 window.EngramMock（落地时换成真实回环 API 调用）。
 */
(function () {
  'use strict'

  var M = window.EngramMock
  var views = window.EngramViews
  var viewRoot = document.getElementById('view')
  var drawerRoot = document.getElementById('drawerRoot')
  var toastRoot = document.getElementById('toastRoot')

  var state = {
    view: 'today',
    scope: 'user',
    today: { revealed: {}, done: {} },
    tour: { focusKind: '', benchQ: '', benchScope: 'all', benchHits: null },
    palace: { status: 'all', kind: 'all', sort: 'tour', q: '', selected: {} },
    log: { filter: 'all' },
    backfill: {
      days: 7, maxTurnsPerSession: 20, maxTotalTurns: 200,
      includeSubagents: false, includeSeeded: false, includeNoCwd: false
    }
  }

  /* ---------- Toast ---------- */
  function toast(message, tone) {
    var node = document.createElement('div')
    node.className = 'toast ' + (tone || 'success')
    node.textContent = message
    toastRoot.appendChild(node)
    setTimeout(function () { node.remove() }, 2600)
  }

  /* ---------- 渲染 ---------- */
  function viewHtml() {
    switch (state.view) {
      case 'today': return views.today(state)
      case 'palace': return views.palace(state)
      case 'tour': return views.tour(state)
      case 'log': return views.log(state)
      case 'backfill': return views.backfill(state)
      default: return views.today(state)
    }
  }

  /** 渲染视图；把焦点与光标还给同一个 data-act 控件，避免筛选输入时掉焦点。 */
  function render() {
    var active = document.activeElement
    var act = active && active.getAttribute ? active.getAttribute('data-act') : null
    var caret = active && typeof active.selectionStart === 'number' ? active.selectionStart : null
    viewRoot.innerHTML = viewHtml()
    if (act) {
      var next = viewRoot.querySelector('[data-act="' + act + '"]')
      if (next) {
        next.focus()
        if (caret !== null && typeof next.setSelectionRange === 'function') {
          try { next.setSelectionRange(caret, caret) } catch (err) { /* number 输入不支持选区，忽略 */ }
        }
      }
    }
  }

  /** 同步导航与 scope 选中态（导航节点本身不重绘，符合冻结外壳约定）。 */
  function syncShell() {
    Array.prototype.forEach.call(document.querySelectorAll('.navItem'), function (node) {
      var on = node.getAttribute('data-view') === state.view
      node.classList.toggle('on', on)
      node.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    Array.prototype.forEach.call(document.querySelectorAll('.segScope .segItem'), function (node) {
      var on = node.getAttribute('data-scope') === state.scope
      node.classList.toggle('on', on)
      node.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    measureIndicator()
    var stats = M.stats[state.scope]
    document.querySelector('[data-nav-count]').textContent = String(stats.total)
    document.querySelector('[data-due-count]').textContent = String(M.due.length)
  }

  /** scope 玻璃指示器：按选中按钮的 offsetLeft / offsetWidth 定位。 */
  function measureIndicator() {
    var indicator = document.querySelector('[data-seg-indicator]')
    var active = document.querySelector('.segScope .segItem.on')
    if (!indicator || !active) return
    indicator.style.left = active.offsetLeft + 'px'
    indicator.style.width = active.offsetWidth + 'px'
  }

  /* ---------- 抽屉 ---------- */
  function closeDrawer() { drawerRoot.innerHTML = '' }

  function openDrawer(html) {
    drawerRoot.innerHTML = '<div class="scrim" data-act="drawer-close"></div>' +
      '<aside class="drawer" role="dialog">' + html + '</aside>'
  }

  var OP_TEXT = {
    write: '写入', update: '修正', superseded: '取代', restore: '恢复', forget: '遗忘',
    decay: '衰减', 'outcome-report': '效果回报', 'ingest-done': '摄取完成'
  }

  function openDetail(id) {
    var memory = M.memories.filter(function (m) { return m.id === id })[0]
    if (!memory) { toast('原型数据里没有这条记忆', 'error'); return }
    var slot = memory.slot ? memory.slot.room + '#' + memory.slot.index : '未排桩'
    var ops = M.activity.filter(function (row) { return OP_TEXT[row.op] }).slice(0, 6)
    openDrawer(
      '<header class="drawerHead"><h3>记忆详情</h3>' +
      '<span class="muted mono grow">#' + memory.id + '</span>' +
      '<button type="button" class="button sm" data-act="drawer-close">关闭</button></header>' +
      '<div class="drawerBody">' +
        '<div class="memTags" style="margin-bottom:var(--space-3)">' +
        '<span class="pill status-' + memory.status + '">' + ({ active: '开放', archived: '归档', forgotten: '已闭馆' })[memory.status] + '</span>' +
        '<span class="pill room" style="--room: var(--room-' + memory.kind + ')">' + memory.slot.room + '</span>' +
        '<span class="pill coord">' + slot + '</span></div>' +
        '<p style="margin-bottom:var(--space-4)">' + memory.content + '</p>' +
        '<dl class="kv">' +
          '<dt>重要性</dt><dd><div class="bar"><i style="width:' + Math.round(memory.importance * 100) + '%"></i></div></dd>' +
          '<dt>置信</dt><dd>' + memory.confidence.toFixed(2) + '</dd>' +
          '<dt>命中次数</dt><dd>' + memory.accessCount + '</dd>' +
          '<dt>来源</dt><dd class="mono">' + (memory.sourceSessionId || '—') + (memory.sourceRound ? ' · 第 ' + memory.sourceRound + ' 轮' : '') + '</dd>' +
          '<dt>刻入时间</dt><dd>' + new Date(memory.createdAt).toISOString().slice(0, 16).replace('T', ' ') + '</dd>' +
        '</dl>' +
        '<div class="divider"></div>' +
        '<h4 style="margin-bottom:var(--space-2)">操作日志</h4>' +
        '<ul class="logList">' + ops.map(function (row) {
          return '<li><span class="muted mono">' + new Date(row.at).toISOString().slice(5, 16).replace('T', ' ') + '</span>' +
            '<span>' + OP_TEXT[row.op] + '</span></li>'
        }).join('') + '</ul>' +
        '<div class="row" style="margin-top:var(--space-4)">' +
          '<button type="button" class="button" data-act="edit" data-id="' + memory.id + '">编辑</button>' +
          '<button type="button" class="button danger" data-act="forget" data-id="' + memory.id + '">遗忘</button>' +
        '</div>' +
      '</div>')
  }

  function openEdit(id) {
    var memory = M.memories.filter(function (m) { return m.id === id })[0]
    if (!memory) { toast('原型数据里没有这条记忆', 'error'); return }
    openDrawer(
      '<header class="drawerHead"><h3>修正记忆</h3>' +
      '<span class="muted mono grow">#' + memory.id + '</span>' +
      '<button type="button" class="button sm" data-act="drawer-close">关闭</button></header>' +
      '<div class="drawerBody">' +
        '<label class="field" style="margin-bottom:var(--space-3)"><span class="fieldLabel">房间</span>' +
        '<select class="input">' + M.rooms.map(function (room) {
          return '<option value="' + room.kind + '"' + (room.kind === memory.kind ? ' selected' : '') + '>' + room.name + '</option>'
        }).join('') + '</select></label>' +
        '<label class="field" style="margin-bottom:var(--space-3)"><span class="fieldLabel">门牌（4-30 字）</span>' +
        '<input class="input" value="包管理器与锁文件"></label>' +
        '<label class="field" style="margin-bottom:var(--space-4)"><span class="fieldLabel">正文</span>' +
        '<textarea class="input" style="height:120px;padding:8px 10px;line-height:1.6">' + memory.content + '</textarea></label>' +
        '<p class="sectionHint" style="margin-bottom:var(--space-4)">保存会写入新条目并把旧条目标记为被取代（取代链保留，可审计）。</p>' +
        '<div class="row"><button type="button" class="button primary" data-act="edit-save">保存修正</button>' +
        '<button type="button" class="button ghost" data-act="drawer-close">取消</button></div>' +
      '</div>')
  }

  /* ---------- 回填进度模拟（演示运行态轮询的数据流动） ---------- */
  var backfillTimer = null
  function startBackfill() {
    if (backfillTimer !== null) { toast('回填已在运行中', 'warning'); return }
    var status = M.backfill.status
    status.state = 'running'
    backfillTimer = setInterval(function () {
      if (status.turnsDone >= status.turnsPlanned) {
        clearInterval(backfillTimer)
        backfillTimer = null
        status.state = 'done'
        toast('回填完成：写入 ' + status.memoriesWritten + ' 条')
        render()
        return
      }
      status.turnsDone += 2
      if (status.turnsDone % 6 === 0) status.memoriesWritten += 1
      render()
    }, 700)
    toast('开始回填：先估算，再逐轮摄取')
    render()
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', function (event) {
    var nav = event.target.closest('.navItem')
    if (nav) { state.view = nav.getAttribute('data-view'); syncShell(); render(); return }

    var scopeNode = event.target.closest('.segScope .segItem')
    if (scopeNode) { state.scope = scopeNode.getAttribute('data-scope'); syncShell(); render(); return }

    var node = event.target.closest('[data-act]')
    if (!node) return
    var act = node.getAttribute('data-act')
    var id = node.getAttribute('data-id')

    switch (act) {
      case 'goto-due':
        state.view = 'today'
        syncShell()
        render()
        requestAnimationFrame(function () {
          var target = document.getElementById('review-section')
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        })
        break
      case 'refresh':
        toast('已刷新（原型数据不变）')
        break
      case 'export':
        toast('原型不写文件：落地后走 engram_export')
        break
      case 'reveal':
        state.today.revealed[id] = true
        render()
        break
      case 'grade':
        state.today.done[id] = true
        toast('已按「' + node.textContent + '」推进复习调度')
        render()
        break
      case 'goto-palace':
        state.view = 'palace'; syncShell(); render()
        break
      case 'focus':
        state.tour.focusKind = node.getAttribute('data-kind')
        render()
        break
      case 'refurb-rescan':
        toast('已重新扫描 291 条开放记忆，发现 3 条建议')
        break
      case 'refurb-run':
        toast('已执行「' + node.getAttribute('data-kind') + '」建议')
        break
      case 'detail': openDetail(id); break
      case 'edit': openEdit(id); break
      case 'forget':
        toast('已遗忘该条（可恢复）')
        closeDrawer()
        break
      case 'edit-save':
        toast('修正已保存：新条目已排桩，旧条目进入取代链')
        closeDrawer()
        break
      case 'drawer-close': closeDrawer(); break
      case 'f-status': state.palace.status = node.getAttribute('data-value'); render(); break
      case 'f-kind': state.palace.kind = node.getAttribute('data-value'); render(); break
      case 'f-sort': state.palace.sort = node.getAttribute('data-value'); render(); break
      case 'select':
        state.palace.selected[id] = !state.palace.selected[id]
        render()
        break
      case 'batch-clear':
        state.palace.selected = {}
        render()
        break
      case 'batch-forget':
      case 'batch-restore':
        toast(act === 'batch-forget' ? '批量遗忘完成' : '批量恢复完成')
        state.palace.selected = {}
        render()
        break
      case 'page-prev':
      case 'page-next':
        toast('原型只有一页数据', 'warning')
        break
      case 'log-filter': state.log.filter = node.getAttribute('data-value'); render(); break
      case 'bench-run': runBench(); break
      case 'bf-start': startBackfill(); break
      case 'bf-pause':
        if (backfillTimer !== null) { clearInterval(backfillTimer); backfillTimer = null; M.backfill.status.state = 'cancelled'; toast('已暂停，进度已保存，可续做'); render() }
        else toast('当前没有运行中的回填', 'warning')
        break
      default: break
    }
  })

  document.addEventListener('input', function (event) {
    var node = event.target.closest('[data-act]')
    if (!node) return
    var act = node.getAttribute('data-act')
    var value = node.value
    switch (act) {
      case 'f-q': state.palace.q = value; render(); break
      case 'bench-q': state.tour.benchQ = value; break
      case 'bf-days': state.backfill.days = Number(value); break
      case 'bf-turns': state.backfill.maxTurnsPerSession = Number(value); break
      case 'bf-total': state.backfill.maxTotalTurns = Number(value); break
      default: break
    }
  })

  document.addEventListener('change', function (event) {
    var node = event.target.closest('[data-act]')
    if (!node) return
    var act = node.getAttribute('data-act')
    var checked = node.checked
    switch (act) {
      case 'bf-sub': state.backfill.includeSubagents = checked; break
      case 'bf-seeded': state.backfill.includeSeeded = checked; break
      case 'bf-nocwd': state.backfill.includeNoCwd = checked; break
      case 'bench-scope': state.tour.benchScope = node.value; break
      default: break
    }
  })

  /** 检索实验台：本地子串检索，模拟混合道返回（语义道 / 关键词道 + 分数）。 */
  function runBench() {
    var q = state.tour.benchQ.trim()
    if (q === '') { toast('先输入查询词', 'warning'); return }
    var hits = M.memories.filter(function (m) {
      return state.tour.benchScope === 'all' || m.scope === state.tour.benchScope
    }).filter(function (m) {
      return m.content.toLowerCase().indexOf(q.toLowerCase()) >= 0
    }).map(function (m, index) {
      return {
        id: m.id,
        kind: m.kind,
        content: m.content,
        via: index % 3 === 2 ? '关键词道' : '语义道',
        score: Math.max(0.21, 0.92 - index * 0.13)
      }
    })
    state.tour.benchHits = hits
    toast(hits.length === 0 ? '无命中：这个词还没有刻进宫殿' : '命中 ' + hits.length + ' 条', hits.length === 0 ? 'warning' : 'success')
    render()
  }

  window.addEventListener('resize', measureIndicator)
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeDrawer()
  })

  syncShell()
  render()
})()
