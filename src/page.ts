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
  :root { color-scheme: dark; --bg: #14161a; --panel: #1c1f26; --line: #2a2f3a; --text: #e6e8ee; --muted: #8b93a3; --accent: #4f8cff; --ok: #3fb96f; --warn: #d9a13b; --bad: #e05d5d; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 5; }
  header h1 { font-size: 16px; margin: 0 auto 0 0; }
  .tabs { display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .tabs button { background: none; border: none; color: var(--muted); padding: 6px 14px; cursor: pointer; font-size: 13px; }
  .tabs button.on { background: var(--accent); color: #fff; }
  button.act { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  button.act:hover { border-color: var(--accent); }
  main { max-width: 980px; margin: 0 auto; padding: 18px 20px 60px; }
  .cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; }
  .card b { display: block; font-size: 20px; }
  .card span { color: var(--muted); font-size: 12px; }
  .filters { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
  .filters select, .filters input { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; font-size: 13px; }
  .filters input { flex: 1; min-width: 200px; }
  .item { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .item .row1 { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
  .badge { font-size: 11px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); }
  .badge.active { color: var(--ok); border-color: var(--ok); }
  .badge.archived { color: var(--warn); border-color: var(--warn); }
  .badge.forgotten { color: var(--bad); border-color: var(--bad); }
  .content { white-space: pre-wrap; word-break: break-word; }
  .meta { color: var(--muted); font-size: 12px; margin-top: 6px; display: flex; gap: 14px; flex-wrap: wrap; }
  .ops { margin-top: 8px; display: flex; gap: 8px; }
  .ops button { font-size: 12px; padding: 3px 10px; }
  .bar { height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; width: 90px; display: inline-block; vertical-align: middle; }
  .bar i { display: block; height: 100%; background: var(--accent); }
  .pager { display: flex; gap: 10px; align-items: center; justify-content: center; margin-top: 14px; color: var(--muted); }
  dialog { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 12px; max-width: 640px; width: 92vw; padding: 18px; }
  dialog::backdrop { background: rgba(0,0,0,.55); }
  dialog h3 { margin: 0 0 10px; font-size: 15px; }
  dialog textarea, dialog input, dialog select { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px; font: inherit; }
  dialog .f { margin-bottom: 10px; }
  dialog label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
  dialog pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; overflow: auto; font-size: 12px; max-height: 320px; white-space: pre-wrap; }
  .modal-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  .primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .empty { text-align: center; color: var(--muted); padding: 40px 0; }
</style>
</head>
<body>
<header>
  <h1>dsh-engram 记忆库</h1>
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
      <option value="active">active</option>
      <option value="archived">archived</option>
      <option value="forgotten">forgotten</option>
    </select>
    <select id="fKind">
      <option value="all">全部种类</option>
      <option value="fact">fact</option>
      <option value="preference">preference</option>
      <option value="decision">decision</option>
      <option value="episode">episode</option>
      <option value="skill">skill</option>
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
      <option value="fact">fact</option><option value="preference">preference</option>
      <option value="decision">decision</option><option value="episode">episode</option>
      <option value="skill">skill</option>
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
  <pre id="rBody"></pre>
  <div class="modal-foot"><button class="act" id="rClose">关闭</button></div>
</dialog>
<script>
(function () {
  'use strict';
  var state = { scope: 'user', status: 'all', kind: 'all', q: '', limit: 20, offset: 0, total: 0 };
  var $ = function (id) { return document.getElementById(id); };

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
  function bar(v) {
    var wrap = el('span', 'bar');
    var fill = el('i');
    fill.style.width = Math.round(v * 100) + '%';
    wrap.appendChild(fill);
    return wrap;
  }
  function loadStats() {
    return api('stats').then(function (data) {
      var cards = $('cards');
      cards.textContent = '';
      data.parts.forEach(function (part) {
        var s = part.stats;
        var on = part.scope === state.scope;
        var card = el('div', 'card');
        if (on) card.style.borderColor = 'var(--accent)';
        card.style.cursor = 'pointer';
        card.appendChild(el('b', undefined, String(s.total)));
        card.appendChild(el('span', undefined, part.scope + ' · active ' + s.active + ' · 信噪比 ' + Math.round(s.signalRatio * 100) + '%'));
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
      data.records.forEach(function (record) {
        var item = el('div', 'item');
        var row1 = el('div', 'row1');
        row1.appendChild(el('span', 'badge ' + record.status, record.status));
        row1.appendChild(el('span', 'badge', record.kind));
        row1.appendChild(el('span', 'badge', record.scope));
        item.appendChild(row1);
        item.appendChild(el('div', 'content', record.content));
        var meta = el('div', 'meta');
        meta.appendChild(el('span', undefined, '重要性 ' + record.importance.toFixed(2) + ' '));
        meta.appendChild(bar(record.importance));
        meta.appendChild(el('span', undefined, '置信 ' + record.confidence.toFixed(2) + ' '));
        meta.appendChild(bar(record.confidence));
        meta.appendChild(el('span', undefined, '访问 ' + record.accessCount + ' 次'));
        var source = record.sourceSessionId
          ? '来源 ' + record.sourceSessionId.slice(0, 16) + '…' + (record.sourceRound === null ? '' : ' 第' + record.sourceRound + '轮')
          : '显式保存';
        meta.appendChild(el('span', undefined, source));
        meta.appendChild(el('span', undefined, fmtTime(record.createdAt)));
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
          forgetBtn.addEventListener('click', function () { post('forget', record, '已遗忘（可恢复）'); });
          ops.appendChild(forgetBtn);
        } else {
          var restoreBtn = el('button', 'act', '恢复');
          restoreBtn.addEventListener('click', function () { post('restore', record, '已恢复为 active'); });
          ops.appendChild(restoreBtn);
        }
        item.appendChild(ops);
        list.appendChild(item);
      });
      var page = Math.floor(state.offset / state.limit) + 1;
      var pages = Math.max(1, Math.ceil(state.total / state.limit));
      $('pageInfo').textContent = '第 ' + page + ' / ' + pages + ' 页 · 共 ' + state.total + ' 条';
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
  function post(route, record, okText) {
    api(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: record.id, scope: record.scope }),
    }).then(function () { reload(); }).catch(function (e) { alert(e.message); });
  }
  function openReview(record) {
    api('review?scope=' + record.scope + '&id=' + encodeURIComponent(record.id)).then(function (view) {
      var r = view.record;
      var lines = [
        '内容: ' + r.content,
        '属性: kind=' + r.kind + ', status=' + r.status + ', importance=' + r.importance + ', confidence=' + r.confidence + ', 访问 ' + r.accessCount + ' 次',
        '来源: ' + (r.sourceSessionId ? r.sourceSessionId + (r.sourceRound === null ? '' : ' 第' + r.sourceRound + '轮') + (r.sourceSeq === null ? '' : ' seq ' + r.sourceSeq) : '显式保存'),
      ];
      if (view.supersededBy.length) lines.push('被谁取代: ' + view.supersededBy.join(', '));
      if (view.supersedes.length) lines.push('取代了谁: ' + view.supersedes.join(', '));
      if (view.contradicts.length) lines.push('矛盾候选: ' + view.contradicts.join(', '));
      if (view.related.length) lines.push('关联: ' + view.related.join(', '));
      if (view.operations.length) {
        lines.push('最近操作:');
        view.operations.forEach(function (op) {
          lines.push('  ' + fmtTime(op.at) + ' ' + op.op + (op.detail ? ' ' + op.detail : ''));
        });
      }
      $('rBody').textContent = lines.join('\\n');
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
