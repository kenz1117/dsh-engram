/**
 * /engram 管理页：自包含单文件 HTML（内联 CSS/JS，简体中文 UI）。
 * 页面 JS 全部使用 DOM API 构建用户内容节点（不用 innerHTML 拼接，
 * 防记忆内容 XSS）。@module @kenz1117/dsh-engram/page
 */

export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-engram 记忆库</title>
<style>
  :root { color-scheme: dark;
    --bg: #0d1015; --bg-soft: #12161d; --panel: #161c26; --line: #262e3c;
    --text: #e9ebf1; --muted: #8d96a8; --faint: #5d6577;
    --accent: #e0a458; --accent-ink: #f2c98a;
    --ok: #4cc38a; --warn: #cfa15c; --bad: #dd6b5c;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --serif: "Songti SC", "STSong", "Noto Serif CJK SC", serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.65 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  /* 顶部环境光：琥珀与青蓝的极淡辉光，给深色底一点空气感。 */
  body::before { position: fixed; inset: 0; z-index: -1; pointer-events: none; content: '';
    background:
      radial-gradient(52% 34% at 22% -6%, rgba(224,164,88,.09), transparent 70%),
      radial-gradient(46% 30% at 82% -8%, rgba(94,200,192,.06), transparent 70%); }
  @keyframes rise { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }

  header { display: flex; align-items: center; gap: 14px; padding: 16px 24px; border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 5;
    background: rgba(13,16,21,.82); backdrop-filter: blur(12px); }
  .brand { margin-right: auto; display: flex; align-items: baseline; gap: 12px; }
  .brand .eyebrow { font-family: var(--mono); font-size: 10px; letter-spacing: .22em; color: var(--faint); }
  .brand h1 { font-family: var(--serif); font-size: 20px; font-weight: 600; margin: 0; letter-spacing: .04em; }
  .tabs { display: flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; background: var(--bg-soft); }
  .tabs button { background: none; border: none; color: var(--muted); padding: 6px 16px; cursor: pointer; font-size: 13px; transition: color .15s, background .15s; }
  .tabs button.on { background: var(--accent); color: #1b1408; font-weight: 600; }
  button.act { background: transparent; color: var(--muted); border: 1px solid var(--line); border-radius: 8px; padding: 6px 13px; cursor: pointer; font-size: 13px; transition: color .15s, border-color .15s, background .15s, transform .1s; }
  button.act:hover { color: var(--accent-ink); border-color: var(--accent); background: rgba(224,164,88,.07); }
  button.act:active { transform: scale(.97); }
  button.act:disabled { opacity: .38; cursor: default; }

  main { max-width: 940px; margin: 0 auto; padding: 22px 24px 72px; }

  /* 统计带：衬线大数字 + 信噪细仪表。 */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 20px; animation: rise .3s ease both; }
  .card { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px 14px; cursor: pointer; overflow: hidden; transition: border-color .18s, transform .18s, box-shadow .18s; }
  .card:hover { transform: translateY(-2px); border-color: var(--faint); box-shadow: 0 10px 26px -14px rgba(0,0,0,.7); }
  .card.on { border-color: rgba(224,164,88,.55); background: linear-gradient(180deg, rgba(224,164,88,.06), transparent 55%), var(--panel); }
  .card.on::before { position: absolute; top: 0; bottom: 0; left: 0; width: 3px; background: var(--accent); content: ''; }
  .card .num { display: block; font-family: var(--serif); font-size: 32px; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .card .sub { color: var(--muted); font-size: 12px; margin-top: 4px; display: block; }
  .card .sub b { color: var(--ok); font-weight: 600; }
  .card .meter { display: block; height: 3px; border-radius: 2px; margin-top: 12px; background: rgba(141,150,168,.16); overflow: hidden; }
  .card .meter i { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--accent), var(--accent-ink)); transition: width .35s ease; }

  .filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; animation: rise .3s .05s ease both; }
  .filters select, .filters input { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 9px; padding: 7px 11px; font-size: 13px; transition: border-color .15s, box-shadow .15s; }
  .filters select:focus-visible, .filters input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(224,164,88,.16); }
  .filters input { flex: 1; min-width: 200px; }

  /* 条目：左侧状态色轨 + 种类琥珀片 + 等宽元信息。 */
  .item { position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px 18px 12px 21px; margin-bottom: 10px; animation: rise .28s ease both; transition: border-color .18s, box-shadow .18s; }
  .item::before { position: absolute; top: 14px; bottom: 14px; left: 0; width: 3px; border-radius: 0 3px 3px 0; background: var(--faint); content: ''; }
  .item.st-active::before { background: var(--ok); }
  .item.st-archived::before { background: var(--warn); }
  .item.st-forgotten::before { background: var(--bad); }
  .item:hover { border-color: rgba(224,164,88,.35); box-shadow: 0 12px 28px -16px rgba(0,0,0,.75); }
  .row1 { display: flex; gap: 10px; align-items: center; margin-bottom: 7px; flex-wrap: wrap; }
  .status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .status::before { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); content: ''; }
  .status.st-active { color: var(--ok); } .status.st-active::before { background: var(--ok); box-shadow: 0 0 0 3px rgba(76,195,138,.14); }
  .status.st-archived { color: var(--warn); } .status.st-archived::before { background: var(--warn); }
  .status.st-forgotten { color: var(--bad); } .status.st-forgotten::before { background: var(--bad); }
  .kind { font-size: 11px; line-height: 18px; padding: 0 8px; border-radius: 6px; color: var(--accent-ink); background: rgba(224,164,88,.1); }
  .scope { font-size: 11px; color: var(--faint); }
  .when { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--faint); }
  .content { white-space: pre-wrap; word-break: break-word; font-size: 14.5px; line-height: 1.75; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .meta { color: var(--muted); font-size: 12px; margin-top: 9px; display: flex; gap: 16px; flex-wrap: wrap; align-items: center; font-family: var(--mono); }
  .mf { display: inline-flex; align-items: center; gap: 7px; }
  .bar { height: 4px; border-radius: 2px; background: rgba(141,150,168,.18); overflow: hidden; width: 52px; display: inline-block; }
  .bar i { display: block; height: 100%; border-radius: 2px; background: var(--accent); }
  .bar.conf i { background: var(--ok); }
  .ops { margin-top: 10px; display: flex; gap: 6px; opacity: .6; transition: opacity .16s; }
  .item:hover .ops, .item:focus-within .ops { opacity: 1; }
  .ops button { font-size: 12px; padding: 4px 11px; border-color: transparent; background: rgba(141,150,168,.1); }
  .ops button:hover { border-color: var(--accent); background: rgba(224,164,88,.08); }

  .pager { display: flex; gap: 12px; align-items: center; justify-content: center; margin-top: 20px; color: var(--muted); font-family: var(--mono); font-size: 12px; }
  .empty { text-align: center; color: var(--muted); padding: 56px 0 60px; }
  .empty::before { display: block; width: 34px; height: 34px; margin: 0 auto 14px; border: 1px solid var(--line); border-radius: 10px; background: linear-gradient(135deg, rgba(224,164,88,.16), transparent 70%); transform: rotate(45deg) scale(.8); content: ''; }

  /* 弹窗：琥珀描边 + 入场缩放。 */
  dialog { background: var(--panel); color: var(--text); border: 1px solid #323b4c; border-radius: 16px; max-width: 660px; width: 92vw; padding: 20px 22px; box-shadow: 0 30px 70px -20px rgba(0,0,0,.8); }
  dialog[open] { animation: pop .18s ease both; }
  @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
  dialog::backdrop { background: rgba(5,7,10,.62); backdrop-filter: blur(3px); }
  dialog h3 { margin: 0 0 14px; font-family: var(--serif); font-size: 17px; font-weight: 600; letter-spacing: .03em; }
  dialog textarea, dialog input, dialog select { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; font: inherit; transition: border-color .15s, box-shadow .15s; }
  dialog textarea:focus-visible, dialog input:focus-visible, dialog select:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(224,164,88,.16); }
  dialog .f { margin-bottom: 12px; }
  dialog label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 5px; }
  dialog input[type='range'] { accent-color: var(--accent); padding: 0; }
  .modal-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .primary { background: var(--accent); border-color: var(--accent); color: #1b1408; font-weight: 600; }
  .primary:hover { background: var(--accent-ink); color: #1b1408; }

  /* 审计弹窗：属性网格 + 关系 chips + 操作时间线。 */
  .grid { display: grid; grid-template-columns: max-content 1fr; gap: 8px 18px; font-size: 13px; align-items: start; }
  .grid .k { color: var(--faint); font-size: 12px; padding-top: 2px; }
  .grid .v { color: var(--text); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .grid .v.content-full { white-space: pre-wrap; word-break: break-word; line-height: 1.7; }
  .rel-h { margin: 16px 0 7px; font-size: 12px; font-weight: 500; color: var(--faint); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chipm { font-family: var(--mono); font-size: 11px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--line); color: var(--muted); background: var(--bg); }
  .timeline { list-style: none; margin: 4px 0 0; padding: 0 0 0 16px; position: relative; }
  .timeline::before { position: absolute; top: 8px; bottom: 8px; left: 3px; width: 1px; background: var(--line); content: ''; }
  .timeline li { position: relative; padding: 6px 0 6px 12px; font-size: 12px; color: var(--muted); line-height: 1.65; }
  .timeline li::before { position: absolute; left: -16px; top: 11px; width: 7px; height: 7px; border-radius: 50%; background: var(--panel); border: 1px solid var(--accent); content: ''; }
  .timeline time { font-family: var(--mono); color: var(--faint); margin-right: 8px; }
  .timeline b { color: var(--text); font-weight: 500; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <span class="eyebrow">DSH · ENGRAM</span>
    <h1>记忆库</h1>
  </div>
  <div class="tabs" id="scopeTabs">
    <button data-scope="user" class="on">用户级</button>
    <button data-scope="project">项目级</button>
  </div>
  <button class="act" id="refresh">刷新</button>
  <button class="act" id="expMd">导出 MD</button>
  <button class="act" id="expJson">导出 JSON</button>
</header>
<main>
  <div class="cards" id="cards"></div>
  <div class="filters">
    <select id="fStatus">
      <option value="all">全部状态</option>
      <option value="active">生效中</option>
      <option value="archived">已归档</option>
      <option value="forgotten">已遗忘</option>
    </select>
    <select id="fKind">
      <option value="all">全部种类</option>
      <option value="fact">事实</option>
      <option value="preference">偏好</option>
      <option value="decision">决策</option>
      <option value="episode">事件</option>
      <option value="skill">技能</option>
    </select>
    <input id="fQ" placeholder="按内容搜索…">
  </div>
  <div id="list"></div>
  <div class="pager">
    <button class="act" id="prev">上一页</button>
    <span id="pageInfo"></span>
    <button class="act" id="next">下一页</button>
  </div>
</main>
<dialog id="editDlg">
  <h3>编辑记忆（写入取代链）</h3>
  <div class="f"><label>内容</label><textarea id="eContent" rows="3"></textarea></div>
  <div class="f"><label>种类</label>
    <select id="eKind">
      <option value="fact">事实</option><option value="preference">偏好</option>
      <option value="decision">决策</option><option value="episode">事件</option>
      <option value="skill">技能</option>
    </select>
  </div>
  <div class="f"><label>重要性：<span id="eImpV">0.5</span></label>
    <input type="range" id="eImp" min="0" max="1" step="0.05" value="0.5">
  </div>
  <div class="modal-foot">
    <button class="act" id="eCancel">取消</button>
    <button class="act primary" id="eSave">保存（旧条目归档）</button>
  </div>
</dialog>
<dialog id="reviewDlg">
  <h3>记忆审计</h3>
  <div id="rBody"></div>
  <div class="modal-foot"><button class="act" id="rClose">关闭</button></div>
</dialog>
<script>
(function () {
  'use strict';
  var state = { scope: 'user', status: 'all', kind: 'all', q: '', limit: 20, offset: 0, total: 0 };
  var $ = function (id) { return document.getElementById(id); };

  var STATUS_ZH = { active: '生效中', archived: '已归档', forgotten: '已遗忘' };
  var KIND_ZH = { fact: '事实', preference: '偏好', decision: '决策', episode: '事件', skill: '技能' };
  var SCOPE_ZH = { user: '用户级', project: '项目级' };
  var OP_ZH = { write: '写入', update: '更新', forget: '遗忘', restore: '恢复', decay: '衰减归档', superseded: '被取代', 'ingest-request': '摄取请求', 'distill-request': '蒸馏请求' };
  var REL_ZH = { supersededBy: '被取代', supersedes: '取代', contradicts: '矛盾', related: '关联' };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function api(path, opts) {
    return fetch('/api/engram/' + path, opts).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : ('HTTP ' + res.status));
        return body;
      });
    });
  }
  function fmtTime(ms) { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); }
  function relTime(ms) {
    var diff = Math.max(0, Date.now() - ms);
    var minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return minutes + ' 分钟前';
    var hours = Math.floor(minutes / 60);
    if (hours < 48) return hours + ' 小时前';
    return Math.floor(hours / 24) + ' 天前';
  }
  function bar(v, conf) {
    var wrap = el('span', conf ? 'bar conf' : 'bar');
    var fill = el('i');
    fill.style.width = Math.round(Math.min(1, Math.max(0, v)) * 100) + '%';
    wrap.appendChild(fill);
    return wrap;
  }
  function sourceText(record) {
    if (!record.sourceSessionId) return '显式保存';
    return '来源 ' + record.sourceSessionId.slice(0, 16) + '…' + (record.sourceRound === null ? '' : ' 第' + record.sourceRound + '轮');
  }
  function statusNode(status) {
    return el('span', 'status st-' + status, STATUS_ZH[status] || status);
  }

  function loadStats() {
    return api('stats').then(function (data) {
      var cards = $('cards');
      cards.textContent = '';
      data.parts.forEach(function (part, index) {
        var s = part.stats;
        var card = el('div', 'card' + (part.scope === state.scope ? ' on' : ''));
        card.style.animationDelay = (index * 40) + 'ms';
        card.appendChild(el('span', 'num', String(s.total)));
        var sub = el('span', 'sub');
        sub.appendChild(document.createTextNode((SCOPE_ZH[part.scope] || part.scope) + ' · '));
        sub.appendChild(el('b', undefined, '生效 ' + s.active));
        sub.appendChild(document.createTextNode(' · 信噪比 ' + Math.round(s.signalRatio * 100) + '%'));
        card.appendChild(sub);
        var meter = el('span', 'meter');
        var fill = el('i');
        fill.style.width = Math.round(s.signalRatio * 100) + '%';
        meter.appendChild(fill);
        card.appendChild(meter);
        card.addEventListener('click', function () { setScope(part.scope); });
        cards.appendChild(card);
      });
    }).catch(function (e) { console.warn(e); });
  }
  function loadList() {
    var qs = 'scope=' + state.scope + '&status=' + state.status + '&kind=' + state.kind
      + '&limit=' + state.limit + '&offset=' + state.offset
      + (state.q ? '&q=' + encodeURIComponent(state.q) : '');
    return api('list?' + qs).then(function (data) {
      state.total = data.total;
      var list = $('list');
      list.textContent = '';
      if (data.records.length === 0) { list.appendChild(el('div', 'empty', '没有符合条件的记忆')); }
      data.records.forEach(function (record, index) {
        var item = el('div', 'item st-' + record.status);
        item.style.animationDelay = (Math.min(index, 12) * 26) + 'ms';
        var row1 = el('div', 'row1');
        row1.appendChild(statusNode(record.status));
        row1.appendChild(el('span', 'kind', KIND_ZH[record.kind] || record.kind));
        row1.appendChild(el('span', 'scope', SCOPE_ZH[record.scope] || record.scope));
        var when = el('span', 'when', relTime(record.createdAt));
        when.title = fmtTime(record.createdAt);
        row1.appendChild(when);
        item.appendChild(row1);
        item.appendChild(el('div', 'content', record.content));
        var meta = el('div', 'meta');
        var imp = el('span', 'mf', '重要性');
        imp.appendChild(bar(record.importance, false));
        imp.appendChild(document.createTextNode(record.importance.toFixed(2)));
        meta.appendChild(imp);
        var conf = el('span', 'mf', '置信');
        conf.appendChild(bar(record.confidence, true));
        conf.appendChild(document.createTextNode(record.confidence.toFixed(2)));
        meta.appendChild(conf);
        meta.appendChild(el('span', undefined, '访问 ' + record.accessCount + ' 次'));
        meta.appendChild(el('span', undefined, sourceText(record)));
        item.appendChild(meta);
        var ops = el('div', 'ops');
        var reviewBtn = el('button', 'act', '详情');
        reviewBtn.addEventListener('click', function () { openReview(record); });
        var editBtn = el('button', 'act', '编辑');
        editBtn.addEventListener('click', function () { openEdit(record); });
        ops.appendChild(reviewBtn);
        ops.appendChild(editBtn);
        if (record.status === 'active') {
          var forgetBtn = el('button', 'act', '遗忘');
          forgetBtn.addEventListener('click', function () { post('forget', record); });
          ops.appendChild(forgetBtn);
        } else {
          var restoreBtn = el('button', 'act', '恢复');
          restoreBtn.addEventListener('click', function () { post('restore', record); });
          ops.appendChild(restoreBtn);
        }
        item.appendChild(ops);
        list.appendChild(item);
      });
      var page = Math.floor(state.offset / state.limit) + 1;
      var pages = Math.max(1, Math.ceil(state.total / state.limit));
      $('pageInfo').textContent = page + ' / ' + pages + ' · 共 ' + state.total + ' 条';
      $('prev').disabled = state.offset === 0;
      $('next').disabled = state.offset + state.limit >= state.total;
    }).catch(function (e) {
      $('list').textContent = '';
      $('list').appendChild(el('div', 'empty', '加载失败：' + e.message));
    });
  }
  function reload() { loadStats(); loadList(); }
  function setScope(scope) {
    state.scope = scope; state.offset = 0;
    document.querySelectorAll('#scopeTabs button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.scope === scope);
    });
    reload();
  }
  function post(route, record) {
    api(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: record.id, scope: record.scope }),
    }).then(function () { reload(); }).catch(function (e) { alert(e.message); });
  }

  /* 审计弹窗：属性网格（完整内容 + 种类/状态/重要性/置信/来源/时间）+ 关系 chips + 操作时间线。 */
  function gridRow(grid, key, valueNode) {
    grid.appendChild(el('span', 'k', key));
    var v = el('span', 'v');
    v.appendChild(valueNode);
    grid.appendChild(v);
    return v;
  }
  function chips(ids) {
    var wrap = el('div', 'chips');
    ids.forEach(function (id) {
      var c = el('span', 'chipm', id.slice(0, 18));
      c.title = id;
      wrap.appendChild(c);
    });
    return wrap;
  }
  function opDetailText(op) {
    if (!op.detail) return '';
    if (op.op !== 'write' && op.op !== 'update' && op.op !== 'superseded') return ' ' + op.detail;
    try {
      var parsed = JSON.parse(op.detail);
      var parts = Object.keys(parsed).map(function (key) {
        var value = parsed[key];
        if (key === 'kind') return '种类=' + (KIND_ZH[value] || value);
        if (key === 'scope') return '作用域=' + (SCOPE_ZH[value] || value);
        if (key === 'status') return '状态=' + (STATUS_ZH[value] || value);
        return key + '=' + String(value);
      });
      return parts.length ? ' ' + parts.join(' · ') : ' ' + op.detail;
    } catch (e) {
      return ' ' + op.detail;
    }
  }
  function openReview(record) {
    api('review?scope=' + record.scope + '&id=' + encodeURIComponent(record.id)).then(function (view) {
      var r = view.record;
      var body = $('rBody');
      body.textContent = '';
      var grid = el('div', 'grid');
      var contentV = gridRow(grid, '内容', document.createTextNode(r.content));
      contentV.classList.add('content-full');
      gridRow(grid, '种类', el('span', 'kind', KIND_ZH[r.kind] || r.kind));
      gridRow(grid, '状态', statusNode(r.status));
      var impV = el('span', 'mf', r.importance.toFixed(2));
      impV.appendChild(bar(r.importance, false));
      gridRow(grid, '重要性', impV);
      var confV = el('span', 'mf', r.confidence.toFixed(2));
      confV.appendChild(bar(r.confidence, true));
      gridRow(grid, '置信', confV);
      gridRow(grid, '来源', document.createTextNode(sourceText(r)));
      gridRow(grid, '访问', document.createTextNode(r.accessCount + ' 次'));
      gridRow(grid, '创建时间', document.createTextNode(fmtTime(r.createdAt)));
      body.appendChild(grid);
      ['supersededBy', 'supersedes', 'contradicts', 'related'].forEach(function (key) {
        var ids = view[key] || [];
        if (!ids.length) return;
        body.appendChild(el('div', 'rel-h', REL_ZH[key]));
        body.appendChild(chips(ids));
      });
      if (view.operations && view.operations.length) {
        body.appendChild(el('div', 'rel-h', '最近操作'));
        var timeline = el('ul', 'timeline');
        view.operations.forEach(function (op) {
          var li = document.createElement('li');
          li.appendChild(el('time', undefined, fmtTime(op.at)));
          li.appendChild(el('b', undefined, OP_ZH[op.op] || op.op));
          li.appendChild(document.createTextNode(opDetailText(op)));
          timeline.appendChild(li);
        });
        body.appendChild(timeline);
      }
      $('reviewDlg').showModal();
    }).catch(function (e) { alert(e.message); });
  }
  function openEdit(record) {
    $('eContent').value = record.content;
    $('eKind').value = record.kind;
    $('eImp').value = record.importance;
    $('eImpV').textContent = record.importance.toFixed(2);
    $('eSave').onclick = function () {
      api('update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: record.id, scope: record.scope,
          content: $('eContent').value, kind: $('eKind').value,
          importance: Number($('eImp').value),
        }),
      }).then(function () { $('editDlg').close(); reload(); })
        .catch(function (e) { alert(e.message); });
    };
    $('editDlg').showModal();
  }

  document.querySelectorAll('#scopeTabs button').forEach(function (b) {
    b.addEventListener('click', function () { setScope(b.dataset.scope); });
  });
  $('refresh').addEventListener('click', reload);
  $('expMd').addEventListener('click', function () { location.href = '/api/engram/export?scope=' + state.scope + '&format=markdown'; });
  $('expJson').addEventListener('click', function () { location.href = '/api/engram/export?scope=' + state.scope + '&format=json'; });
  $('fStatus').addEventListener('change', function (e) { state.status = e.target.value; state.offset = 0; loadList(); });
  $('fKind').addEventListener('change', function (e) { state.kind = e.target.value; state.offset = 0; loadList(); });
  var qTimer = null;
  $('fQ').addEventListener('input', function (e) {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { state.q = e.target.value.trim(); state.offset = 0; loadList(); }, 300);
  });
  $('prev').addEventListener('click', function () { state.offset = Math.max(0, state.offset - state.limit); loadList(); });
  $('next').addEventListener('click', function () { state.offset += state.limit; loadList(); });
  $('eImp').addEventListener('input', function (e) { $('eImpV').textContent = Number(e.target.value).toFixed(2); });
  $('eCancel').addEventListener('click', function () { $('editDlg').close(); });
  $('rClose').addEventListener('click', function () { $('reviewDlg').close(); });

  reload();
})();
</script>
</body>
</html>
`
