#!/usr/bin/env node
/**
 * Панельная вёрстка: проверки, которые не ловит ни один другой гейт.
 *
 * 0.13.x выпустил семь патчей подряд почти все по скриншотам пользователя:
 * typecheck / lint / tests / словарь не проверяют рендеринг. Этот скрипт —
 * недостающая ступень лестницы проверки: собирает настоящий CSS модулей
 * + фикстурный DOM из той же разметки, гоняет через headless Chrome и
 * меряет инварианты, нарушение которых уже один раз уехало в релиз.
 *
 * Инварианты (все они реально ломались в 0.13.0–0.13.5):
 *   1. рабочая область панели прокручивается, страница хоста — нет;
 *   2. пункты левого рельса — одна строка текста, рельс не сжимает заголовки в столбик;
 *   3. заголовок рабочей области на странице один, порядок «заголовок → подзаголовок → табы»;
 *   4. длинная подпись кнопки подтверждения не съедает строку (flex:none + max-width);
 *   5. тело ящика на всю ширину, чипы id в одну строку;
 *   6. строки runtime-списка: имя не наезжает на следующие колонки;
 *   7. панель массовых операций: счётчик слева, кнопки нормальной высоты.
 *
 * Ограничение честности: фикстурный DOM повторяет разметку руками и может
 * устареть. Инварианты намеренно грубые (порядок, единственность, «в одну
 * строку», «не наезжает») — они ломаются только вместе с настоящей вёрсткой.
 *
 * Запуск: pnpm check:layout   (нужен headless Chrome/Chromium)
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const css = name => readFileSync(join(ROOT, 'src/client', name), 'utf8')

const panel = css('panel.module.css')
const shell = css('shell/shell.module.css')
const ui = css('ui/ui.module.css')

// Host-переменные, которых в тестовой среде нет: панель читает их из темы DSH.
const STUB = `
:root {
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px; --space-6: 24px; --space-7: 32px;
  --fs-micro: 11px; --fs-body: 13px; --fs-ctrl: 12px; --fs-display: 18px;
  --radius-card: 12px; --radius-control: 8px;
  --dur-fast: 120ms; --dur-base: 200ms; --dur-slow: 320ms;
  --ease-spring: cubic-bezier(.2,.8,.2,1); --ease-out: cubic-bezier(0,0,.2,1);
  --brand-1: #f0a44a; --brand-2: #e05a7a; --brand-grad: linear-gradient(90deg,#f0a44a,#e05a7a); --brand-grad-line: #e05a7a;
  --dsw-alias-bg-base: #fff; --dsw-alias-bg-layer-1: #f7f8fa;
  --dsw-alias-border-l1: #eef0f3; --dsw-alias-border-l2: #dfe3e8;
  --dsw-alias-label-primary: #1d2129; --dsw-alias-label-secondary: #4e5969; --dsw-alias-label-tertiary: #86909c;
  --dsw-alias-state-success-primary: #16a394; --dsw-alias-state-warn-primary: #e08a2e; --dsw-alias-state-danger-primary: #d54941;
  --dsw-alias-brand-primary: #f0a44a; --dsw-alias-fill-tsp-secondary: #f2f3f5;
  --room-fact:#3b6ef5; --room-preference:#a45cf0; --room-decision:#16a394; --room-episode:#e08a2e; --room-skill:#d94f8a;
  --entity-person:#5b8def; --entity-project:#e08a2e; --entity-tool:#3cb489; --entity-concept:#9b6bd9; --entity-other:#7d8590;
}
html, body { margin: 0; height: 100%; background: #fff; }
`

const RAIL = ['总览', '召回', '记忆', '治理', '回放', '系统'].map((label, i) =>
  `<button class="railItem" aria-current="${i === 2 ? 'true' : 'false'}">` +
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="3"/></svg>' +
  `<span>${label}</span></button>`).join('')

const TABS = ['记录', '时间线', '实体', '图谱'].map((label, i) =>
  `<button class="contextItem" aria-pressed="${i === 0 ? 'true' : 'false'}">${label}</button>`).join('')

const CONTENT = Array.from({ length: 14 }, (_, i) =>
  `<div style="height:180px;border-bottom:1px solid #eee">内容块 ${i + 1}</div>`).join('')

const ITEM = (selected) => `
<div class="item${selected ? ' selected' : ''}"><input class="itemCheck" type="checkbox"${selected ? ' checked' : ''}>
<div class="itemBody"><div class="itemTags"><span class="pill">对外开放</span><span class="itemStamp">私人 · 6 天前</span></div>
<div class="content">用户的 macOS 用户名/家目录为 ken (/Users/ken)</div>
<div class="itemMeta"><span><b>地标亮度</b> 0.40</span><span><b>考据可靠度</b> 0.30</span></div></div>
<div class="itemOps"><button class="button">参观</button><button class="button">修缮</button><button class="button">封门</button></div></div>`

const REFURB_ARMED = `
<div class="refurbItem"><div class="refurbRow"><button class="refurbBadge">合并</button>
<div class="refurbReason">与 1 条记忆内容前 20 字重复，建议蒸馏合并。</div>
<span class="refurbConfidence">60%</span>
<button class="refurbExec button confirmArmed">确认合并 2 条相似记忆？将触发 engram_distill 把它们归纳为 1 条高层规律。</button></div></div>`

const DRAWER = `
<div class="drawerLayer"><div class="drawer" style="position:relative">
<header class="drawerHead"><div class="drawerTitle"><h3>记忆铭牌</h3></div><button class="drawerClose">×</button></header>
<div class="drawerBody"><div class="reviewGrid"><div>
<div class="identityStrip">
<span class="identityItem"><span class="identityLabel">稳定身份</span><code class="identityCode">8303a8ec-dbb3-482c-a7d3-d400abae6d23</code></span>
<span class="identityItem"><span class="identityLabel">当前修订</span><code class="identityCode">8303a8ec-dbb3-482c-a7d3-d400abae6d23</code></span>
</div>
<p class="reviewContent">给 DSH desktop profile 装/升级第三方 host+client 插件时：用应用自带 pnpm 直接操作，目录 ~/.dsh/profiles/desktop。要点：① pnpm 11 有 24 小时新包政策；② 每次操作前备份 package.json；③ 应用重启时会 reconcile profile。</p>
<dl class="attrGrid"><dt>种类</dt><dd>技法坊</dd></dl>
</div></div></div></div></div>`

const SYSROW = `
<div class="panelCard"><h3 class="cardTitle">嵌入模型</h3><div class="sysList">
<div class="sysRow"><span class="sysName">bge-small-zh-v1.5-quantized-onnx</span><span class="sysTag">Q8</span><span class="sysNum">512</span></div>
<div class="sysRow"><span class="sysName">paraphrase-multilingual-MiniLM-L12-v2</span><span class="sysTag">F32</span><span class="sysNum">384</span></div>
</div></div>`

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>panel-layout-verify</title>
<style>${STUB}${panel}${shell}${ui}</style></head><body>
<div class="panelRoot" style="height:100vh"><div class="panel">
<div class="panelSticky"><div style="height:64px">HEADER</div></div>
<div class="console">
  <nav class="rail"><p class="railLabel">工作面</p>${RAIL}</nav>
  <div class="consoleBody">
    <header class="pageHeader"><div class="pageHeaderMain"><h2 class="pageTitle">记忆</h2><p class="pageSubtitle">全量记忆库</p></div></header>
    <nav class="contextNav" aria-label="记忆">${TABS}</nav>
    <div class="panelBody">
      <div class="batchBar"><span>已选 1 条</span><button class="button">本页全选</button><button class="button">批量封门（1）</button></div>
      <div class="itemList">${ITEM(true)}${ITEM(false)}</div>
      <section class="panelCard"><div class="refurb">${REFURB_ARMED}</div></section>
      ${SYSROW}
      ${CONTENT}
    </div>
  </div>
</div>
${DRAWER}
</div></div>
<pre id="report"></pre>
<script>
const r = {};
const box = (el) => el.getBoundingClientRect();
// 1. 滚动收容在工作面内容区
const body = document.querySelector('.panelBody');
r.bodyScrollable = body.scrollHeight > body.clientHeight;
r.documentScrollable = document.documentElement.scrollHeight > document.documentElement.clientHeight;
// 2. rail：单行文字 + 列宽固定
const railLabel = document.querySelector('.railItem span');
r.railTextH = box(railLabel).height;
r.railW = box(document.querySelector('.rail')).width;
// 3. 页面标题唯一 + 顺序
r.titleCount = document.querySelectorAll('.pageTitle').length;
const title = box(document.querySelector('.pageTitle'));
const subtitle = box(document.querySelector('.pageSubtitle'));
const tabs = box(document.querySelector('.contextNav'));
r.headerOrder = title.top < subtitle.top && subtitle.top < tabs.top;
// 4. 确认按钮长标签不撑爆行
const armed = document.querySelector('.confirmArmed');
r.armedOverflow = box(armed).right > box(armed.closest('.refurbItem')).right;
r.armedW = box(armed).width;
// 5. 抽屉正文占满 + id 芯片单行
const drawerBody = box(document.querySelector('.drawerBody'));
const reviewContent = box(document.querySelector('.reviewContent'));
r.drawerContentW = reviewContent.width;
r.drawerBodyW = drawerBody.width;
const code = box(document.querySelector('.identityCode'));
r.identityCodeH = code.height;
// 6. sysRow 名称列不与后续列重叠
const row = document.querySelector('.sysRow');
const name = box(row.querySelector('.sysName'));
const tag = box(row.querySelector('.sysTag'));
r.sysNameH = name.height;
r.sysOverlap = name.right > tag.left;
// 7. 批量条
const bar = document.querySelector('.batchBar');
r.batchBtnH = box(bar.querySelector('.button')).height;
r.batchCountFont = getComputedStyle(bar.querySelector('span')).fontSize;
document.getElementById('report').textContent = JSON.stringify(r);
</script></body></html>`

const dir = mkdtempSync(join(tmpdir(), 'engram-layout-'))
const file = join(dir, 'panel.html')
writeFileSync(file, html)

function findChrome() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  console.error('未找到 headless Chrome/Chromium：本脚本用它做渲染量测（这是 typecheck/tests 拦不住的那层）。')
  process.exit(2)
}

let dom
try {
  dom = execFileSync(findChrome(), [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    '--window-size=1400,900', '--virtual-time-budget=3000', '--dump-dom', file,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const match = /<pre id="report">([^<]*)<\/pre>/.exec(dom)
if (match === null) {
  console.error('Chrome 未输出量测结果（页面加载失败？）')
  process.exit(1)
}
const r = JSON.parse(match[1])

const failures = []
const check = (ok, label, detail) => {
  if (ok) console.log(`  ок  ${label}`)
  else failures.push(`${label} — ${detail}`)
}

check(r.bodyScrollable === true, '工作面内容区自滚（内容溢出时出现滚动）', `scrollHeight=${r.bodyScrollable}`)
check(r.documentScrollable === false, '宿主页面不出现第二条滚动条', `document scrollable=${r.documentScrollable}`)
check(r.railTextH < 20, 'rail 标题单行（不吃进 18px 图标列变竖排）', `text height=${r.railTextH}`)
check(r.railW >= 120 && r.railW <= 150, 'rail 列宽固定不塌', `width=${r.railW}`)
check(r.titleCount === 1, '页面标题唯一（legend 泄漏会变成两个）', `count=${r.titleCount}`)
check(r.headerOrder === true, '顺序：标题 → 副标题 → 二级导航', `order=${r.headerOrder}`)
check(r.armedOverflow === false, '确认按钮长标签不撑出所在行', `overflow=${r.armedOverflow}`)
check(r.armedW <= 280, '确认态按钮宽度有绝对上限（24em 截断，不随标签长度增长）', `width=${r.armedW}`)
check(r.drawerContentW >= r.drawerBodyW - 40, '抽屉正文占满宽度（容差=两侧 padding）', `content=${r.drawerContentW} body=${r.drawerBodyW}`)
check(r.identityCodeH < 20, '身份芯片单行（uuid 不拆两行）', `height=${r.identityCodeH}`)
check(r.sysNameH < 20, 'runtime 列表名称单行（模型名不压成竖排）', `height=${r.sysNameH}`)
check(r.sysOverlap === false, 'runtime 列表名称不与类型列叠字', `overlap=${r.sysOverlap}`)
check(r.batchBtnH > 20 && r.batchBtnH < 32, '批量条按钮保持紧凑高度', `height=${r.batchBtnH}`)
check(r.batchCountFont === '12px', '批量条计数用正文字号', `font=${r.batchCountFont}`)

if (failures.length > 0) {
  console.error(`\n布局门禁未过（${failures.length} 项）：`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('\n布局门禁全绿（headless Chrome 实测）。')
