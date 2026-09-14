/**
 * 리포터 — HTML + Excel 리포트 생성 (목업 디자인 기반)
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const STCOLOR = {
  PASS: '#1f9d6b', ERROR: '#d1435b', 'NO-RESPONSE': '#c67a12',
  EXCLUDED: '#7a8194', UNCLICKABLE: '#7a8194',
};
const STBG = {
  PASS: '#e6f5ee', ERROR: '#fbe8ec', 'NO-RESPONSE': '#fbf0dd',
  EXCLUDED: '#eef0f4', UNCLICKABLE: '#eef0f4',
};

function counts(list) {
  const c = { PASS: 0, ERROR: 0, 'NO-RESPONSE': 0, EXCLUDED: 0, UNCLICKABLE: 0 };
  list.forEach(d => { c[d.status] = (c[d.status] || 0) + 1; });
  return c;
}

function severity(item) {
  if (item.status === 'ERROR') return 'P1';
  if (item.status === 'NO-RESPONSE') return 'P2';
  return '--';
}

function sigHtml(item) {
  if (item.status === 'EXCLUDED' || item.status === 'UNCLICKABLE') return '<span class="sig">—</span>';
  const SIGLABEL = { dom: 'DOM', net: 'NET', url: 'URL', console: 'CON' };
  return Object.entries(SIGLABEL).map(([k, label]) => {
    const v = item.signals?.[k];
    const cls = (k === 'console' && v && item.status === 'ERROR') ? 'err' : (v ? 'hit' : 'miss');
    return `<span class="sig ${cls}">${label}</span>`;
  }).join('');
}

function rowHtml(item, idx) {
  const sev = severity(item);
  return `<div class="lrow" onclick="openDrawer(${idx})">
    <div><span class="badge ${item.status}">${item.status}</span></div>
    <div><span class="sev ${sev}">${sev}</span></div>
    <div><div class="el-label">${esc(item.label)}</div><div class="el-loc">${esc(item.sel)}</div></div>
    <div class="signals">${sigHtml(item)}</div>
    <div class="repro">${esc(item.reason || reproText(item))}</div>
  </div>`;
}

function reproText(item) {
  if (item.status === 'NO-RESPONSE') return '클릭 후 무변화';
  if (item.status === 'ERROR') {
    if (item.signals?.console) return 'JS 예외 발생';
    return '서버 4xx/5xx';
  }
  if (item.status === 'PASS') {
    const hits = [];
    if (item.signals?.dom) hits.push('DOM');
    if (item.signals?.net) hits.push('NET');
    if (item.signals?.url) hits.push('URL');
    return hits.join('+') + ' 변화';
  }
  return '';
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(results, meta) {
  const c = counts(results);
  const tested = c.PASS + c.ERROR + c['NO-RESPONSE'];
  const rate = tested ? Math.round(c.PASS / tested * 100) : 0;
  const pages = [...new Set(results.map(d => d.page))];

  const circ = 339.3;
  const offset = circ - (circ * rate / 100);
  const ringColor = rate >= 80 ? '#1f9d6b' : rate >= 50 ? '#c67a12' : '#d1435b';

  const coverageHtml = pages.map(p => {
    const items = results.filter(d => d.page === p);
    const pc = counts(items);
    const tot = items.length;
    const seg = ['PASS', 'ERROR', 'NO-RESPONSE', 'EXCLUDED'].map(s =>
      pc[s] ? `<i style="width:${pc[s] / tot * 100}%;background:${STCOLOR[s]}"></i>` : ''
    ).join('');
    const bad = pc.ERROR + pc['NO-RESPONSE'];
    return `<div class="pgbar">
      <div class="top"><span class="p">${esc(p)}</span><span class="c" style="color:${bad ? '#d1435b' : '#1f9d6b'}">${bad ? bad + ' 결함' : 'clean'}</span></div>
      <div class="pgtrack">${seg}</div>
    </div>`;
  }).join('');

  const dataJson = JSON.stringify(results.map((r, i) => ({
    ...r,
    _idx: i,
    _sev: severity(r),
    _repro: r.reason || reproText(r),
  })));

  const groupedRows = pages.map(p => {
    const items = results.map((r, i) => ({ ...r, _idx: i })).filter(d => d.page === p);
    const pc = counts(items);
    const mini = ['PASS', 'ERROR', 'NO-RESPONSE', 'EXCLUDED'].filter(s => pc[s]).map(s =>
      `<span style="background:${STBG[s]};color:${STCOLOR[s]};padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700">${pc[s]}</span>`
    ).join('');
    return `<div class="grphead">📄 <span>${esc(p)}</span><span class="u">· ${items.length}개 요소</span><div class="mini">${mini}</div></div>
      <div class="lhead"><div>상태</div><div>심각도</div><div>요소</div><div>감지 신호</div><div>재현</div></div>
      ${items.map(item => rowHtml(item, item._idx)).join('')}`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Smoke 리포트 — ${esc(meta.url)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<style>
  :root{
    --ink:#141821;--ink-soft:#4a5162;--ink-faint:#8b91a0;--line:#e3e6ec;--bg:#f6f7f9;
    --panel:#ffffff;--brand:#2f5bea;--brand-ink:#1b3aa0;--brand-bg:#eef2fe;
    --pass:#1f9d6b;--pass-bg:#e6f5ee;--error:#d1435b;--error-bg:#fbe8ec;
    --noresp:#c67a12;--noresp-bg:#fbf0dd;--excl:#7a8194;--excl-bg:#eef0f4;
    --mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;
    --sans:'Inter',system-ui,-apple-system,'Malgun Gothic',sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--sans);background:var(--bg);color:var(--ink);line-height:1.5;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1220px;margin:0 auto;padding:0 20px}
  button{font-family:inherit}
  header{background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:30}
  .hbar{display:flex;align-items:center;gap:14px;height:60px}
  .logo{display:flex;align-items:center;gap:9px;font-weight:700;font-size:18px;letter-spacing:-.02em}
  .logo .dot{width:11px;height:11px;border-radius:3px;background:var(--brand);box-shadow:0 0 0 4px rgba(47,91,234,.14)}
  .logo small{font-family:var(--mono);font-size:11px;font-weight:500;color:var(--ink-soft);background:var(--bg);padding:2px 7px;border-radius:5px;border:1px solid var(--line)}
  .htail{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--ink-soft)}
  .meta{margin:16px 0;font-family:var(--mono);font-size:12px;color:var(--ink-soft);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px;display:flex;gap:24px;flex-wrap:wrap}
  .meta b{color:var(--ink)}
  .dash{display:grid;grid-template-columns:1.1fr 1fr .9fr;gap:16px;margin-bottom:16px;margin-top:20px}
  @media(max-width:900px){.dash{grid-template-columns:1fr}}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px}
  .card h3{font-size:12px;font-family:var(--mono);color:var(--ink-soft);font-weight:600;margin-bottom:14px}
  .passrate{display:flex;align-items:center;gap:20px}
  .ring{position:relative;width:126px;height:126px;flex-shrink:0}
  .ring svg{transform:rotate(-90deg)}
  .ring .val{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .ring .val b{font-size:29px;font-weight:700}
  .ring .val small{font-family:var(--mono);font-size:10px;color:var(--ink-soft)}
  .breakdown{flex:1;display:flex;flex-direction:column;gap:8px}
  .brow{display:flex;align-items:center;gap:9px;font-size:13px}
  .brow .sw{width:11px;height:11px;border-radius:3px;flex-shrink:0}
  .brow .nm{color:var(--ink-soft)}
  .brow .ct{margin-left:auto;font-family:var(--mono);font-weight:600}
  .stats{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
  .stat{border:1px solid var(--line);border-radius:10px;padding:12px 13px;position:relative;overflow:hidden}
  .stat .n{font-size:24px;font-weight:700;font-family:var(--mono)}
  .stat .l{font-size:11px;color:var(--ink-soft);margin-top:2px}
  .stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px}
  .stat.pass::before{background:var(--pass)}.stat.pass .n{color:var(--pass)}
  .stat.error::before{background:var(--error)}.stat.error .n{color:var(--error)}
  .stat.noresp::before{background:var(--noresp)}.stat.noresp .n{color:var(--noresp)}
  .stat.excl::before{background:var(--excl)}.stat.excl .n{color:var(--excl)}
  .pagecov{display:flex;flex-direction:column;gap:9px}
  .pgbar{display:flex;flex-direction:column;gap:4px}
  .pgbar .top{display:flex;justify-content:space-between;font-size:12px}
  .pgbar .top .p{font-family:var(--mono);color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}
  .pgbar .top .c{font-family:var(--mono);font-weight:600;font-size:11px}
  .pgtrack{height:6px;border-radius:99px;overflow:hidden;display:flex;background:var(--bg)}
  .pgtrack i{display:block;height:100%}
  .toolbar{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .filters{display:flex;gap:6px;flex-wrap:wrap}
  .chip{border:1px solid var(--line);background:#fff;border-radius:99px;padding:6px 13px;font-size:12px;font-weight:600;cursor:pointer;color:var(--ink-soft);font-family:var(--mono);transition:.12s}
  .chip:hover{border-color:var(--brand)}
  .chip.active{background:var(--ink);color:#fff;border-color:var(--ink)}
  .chip.active[data-f="ERROR"]{background:var(--error);border-color:var(--error)}
  .chip.active[data-f="NO-RESPONSE"]{background:var(--noresp);border-color:var(--noresp)}
  .chip.active[data-f="PASS"]{background:var(--pass);border-color:var(--pass)}
  .search{border:1px solid var(--line);border-radius:8px;padding:7px 11px;font-size:13px;min-width:170px;font-family:var(--mono)}
  .search:focus{outline:none;border-color:var(--brand)}
  .exports{margin-left:auto;display:flex;gap:7px}
  .btn-ghost{background:#fff;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer;transition:.12s}
  .btn-ghost:hover{border-color:var(--brand);color:var(--brand-ink)}
  .list{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:40px}
  .grphead{background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:10px}
  .grphead .u{color:var(--ink-soft);font-weight:500}
  .grphead .mini{margin-left:auto;display:flex;gap:5px}
  .lhead,.lrow{display:grid;grid-template-columns:96px 62px 1fr 1.3fr 96px;gap:12px;align-items:center;padding:11px 16px}
  .lhead{background:#fbfcfd;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:11px;font-weight:600;color:var(--ink-faint)}
  .lrow{border-bottom:1px solid var(--line);font-size:13px;cursor:pointer;transition:.1s}
  .lrow:last-child{border-bottom:none}
  .lrow:hover{background:#fafbfc}
  .badge{font-family:var(--mono);font-size:10px;font-weight:700;padding:4px 7px;border-radius:6px;text-align:center}
  .badge.PASS{background:var(--pass-bg);color:var(--pass)}
  .badge.ERROR{background:var(--error-bg);color:var(--error)}
  .badge.NO-RESPONSE{background:var(--noresp-bg);color:var(--noresp)}
  .badge.EXCLUDED,.badge.UNCLICKABLE{background:var(--excl-bg);color:var(--excl)}
  .sev{font-family:var(--mono);font-size:10px;font-weight:700;padding:3px 6px;border-radius:5px;text-align:center;border:1px solid}
  .sev.P1{color:var(--error);border-color:var(--error)}
  .sev.P2{color:var(--noresp);border-color:var(--noresp)}
  .sev.--{color:var(--ink-faint);border-color:var(--line);opacity:.5}
  .el-label{font-weight:600}
  .el-loc{font-family:var(--mono);font-size:11px;color:var(--ink-soft);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .signals{display:flex;gap:4px;flex-wrap:wrap}
  .sig{font-family:var(--mono);font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg);border:1px solid var(--line);color:var(--ink-soft)}
  .sig.hit{background:var(--pass-bg);color:var(--pass);border-color:transparent}
  .sig.miss{background:#fff;color:#c3c8d2;text-decoration:line-through}
  .sig.err{background:var(--error-bg);color:var(--error);border-color:transparent}
  .repro{font-family:var(--mono);font-size:11px;color:var(--ink-soft)}
  .empty{padding:44px;text-align:center;color:var(--ink-soft);font-size:13px}
  .drawer{position:fixed;top:0;right:0;bottom:0;width:440px;max-width:92vw;background:var(--panel);border-left:1px solid var(--line);box-shadow:-8px 0 30px rgba(0,0,0,.08);transform:translateX(100%);transition:transform .28s cubic-bezier(.4,0,.2,1);z-index:40;display:flex;flex-direction:column}
  .drawer.on{transform:translateX(0)}
  .dhead{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;gap:12px}
  .dhead .x{margin-left:auto;background:var(--bg);border:1px solid var(--line);border-radius:7px;width:30px;height:30px;cursor:pointer;font-size:16px;color:var(--ink-soft);flex-shrink:0}
  .dbody{padding:20px;overflow-y:auto;flex:1}
  .dsec{margin-bottom:20px}
  .dsec .t{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--ink-faint);margin-bottom:8px}
  .kv{display:flex;gap:8px;font-size:13px;padding:5px 0;border-bottom:1px solid var(--bg)}
  .kv .k{color:var(--ink-soft);min-width:90px;font-family:var(--mono);font-size:11px}
  .kv .v{font-weight:500;word-break:break-all}
  .code{background:#141821;color:#c7d0e0;font-family:var(--mono);font-size:12px;padding:11px 13px;border-radius:8px;position:relative;line-height:1.7;word-break:break-all}
  .code .cp{position:absolute;top:8px;right:8px;background:#2a3142;color:#9aa4b8;border:none;border-radius:5px;padding:3px 8px;font-size:10px;cursor:pointer;font-family:var(--mono)}
  .steps{counter-reset:s;display:flex;flex-direction:column;gap:8px}
  .step{display:flex;gap:10px;font-size:13px;align-items:flex-start}
  .step::before{counter-increment:s;content:counter(s);background:var(--brand-bg);color:var(--brand-ink);font-family:var(--mono);font-size:11px;font-weight:700;width:20px;height:20px;border-radius:5px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .dfoot{padding:14px 20px;border-top:1px solid var(--line);display:flex;gap:8px}
  .dfoot button{flex:1}
  .btn-primary{background:var(--brand);color:#fff;border:none;border-radius:8px;padding:0 16px;height:38px;font-size:14px;font-weight:600;cursor:pointer}
  .overlay{position:fixed;inset:0;background:rgba(20,24,33,.3);opacity:0;pointer-events:none;transition:.28s;z-index:35}
  .overlay.on{opacity:1;pointer-events:auto}
  .toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--ink);color:#fff;padding:11px 18px;border-radius:9px;font-size:13px;opacity:0;transition:.25s;pointer-events:none;z-index:60;font-weight:500}
  .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
  footer{text-align:center;padding:26px;font-family:var(--mono);font-size:11px;color:#a7adba}
</style>
</head>
<body>
<header>
  <div class="wrap hbar">
    <div class="logo"><span class="dot"></span>Smoke <small>auto smoke-test</small></div>
    <div class="htail">${esc(meta.scannedAt)}</div>
  </div>
</header>
<div class="wrap">
  <div class="meta">
    <span><b>URL</b> ${esc(meta.url)}</span>
    <span><b>범위</b> ${esc(meta.scope)}</span>
    <span><b>페이지</b> ${pages.length}개</span>
    <span><b>소요</b> ${meta.elapsed}s</span>
  </div>
  <div class="dash">
    <div class="card">
      <h3>PASS RATE</h3>
      <div class="passrate">
        <div class="ring">
          <svg width="126" height="126">
            <circle cx="63" cy="63" r="54" fill="none" stroke="#eef0f4" stroke-width="13"/>
            <circle cx="63" cy="63" r="54" fill="none" stroke="${ringColor}" stroke-width="13" stroke-linecap="round" stroke-dasharray="339.3" stroke-dashoffset="${offset}"/>
          </svg>
          <div class="val"><b>${rate}%</b><small>passed</small></div>
        </div>
        <div class="breakdown">
          ${[['정상', '#1f9d6b', c.PASS], ['에러', '#d1435b', c.ERROR], ['무감', '#c67a12', c['NO-RESPONSE']], ['제외', '#7a8194', c.EXCLUDED]].map(
            ([nm, color, ct]) => `<div class="brow"><span class="sw" style="background:${color}"></span><span class="nm">${nm}</span><span class="ct">${ct}</span></div>`
          ).join('')}
        </div>
      </div>
    </div>
    <div class="card">
      <h3>결함 집계</h3>
      <div class="stats">
        <div class="stat pass"><div class="n">${c.PASS}</div><div class="l">정상 PASS</div></div>
        <div class="stat error"><div class="n">${c.ERROR}</div><div class="l">에러 ERROR</div></div>
        <div class="stat noresp"><div class="n">${c['NO-RESPONSE']}</div><div class="l">무감 NO-RESPONSE</div></div>
        <div class="stat excl"><div class="n">${c.EXCLUDED + (c.UNCLICKABLE || 0)}</div><div class="l">제외 EXCLUDED</div></div>
      </div>
    </div>
    <div class="card">
      <h3>페이지별 커버리지 <span style="font-family:var(--mono);font-weight:500;color:var(--ink-faint);font-size:11px">${pages.length} pages</span></h3>
      <div class="pagecov">${coverageHtml}</div>
    </div>
  </div>
  <div class="toolbar">
    <div class="filters" id="filters">
      <button class="chip active" data-f="ALL" onclick="setFilter('ALL')">전체</button>
      <button class="chip" data-f="ERROR" onclick="setFilter('ERROR')">에러</button>
      <button class="chip" data-f="NO-RESPONSE" onclick="setFilter('NO-RESPONSE')">무감</button>
      <button class="chip" data-f="PASS" onclick="setFilter('PASS')">정상</button>
      <button class="chip" data-f="EXCLUDED" onclick="setFilter('EXCLUDED')">제외</button>
    </div>
    <input class="search" id="search" placeholder="요소·위치 검색" oninput="renderRows()">
    <div class="exports">
      <button class="btn-ghost" onclick="exportExcel()">Excel</button>
      <button class="btn-ghost" onclick="window.print()">PDF</button>
    </div>
  </div>
  <div class="list" id="list">${groupedRows}</div>
</div>

<div class="overlay" id="overlay" onclick="closeDrawer()"></div>
<div class="drawer" id="drawer">
  <div class="dhead">
    <div>
      <div id="dTitle" style="font-weight:700;font-size:16px">—</div>
      <div id="dSub" style="font-family:var(--mono);font-size:11px;color:var(--ink-soft);margin-top:3px">—</div>
    </div>
    <button class="x" onclick="closeDrawer()">×</button>
  </div>
  <div class="dbody" id="dBody"></div>
  <div class="dfoot">
    <button class="btn-ghost" style="justify-content:center" onclick="copySelector()">Selector 복사</button>
    <button class="btn-primary" style="height:auto;padding:9px 0" onclick="copyTicket()">이슈 티켓 복사</button>
  </div>
</div>
<div class="toast" id="toast"></div>
<footer>Smoke · 자동 스모크 테스트 리포트 — Playwright 기반</footer>

<script>
const DATA = ${dataJson};
const SIGLABEL = {dom:'DOM',net:'NET',url:'URL',console:'CON'};
const STCOLOR = {PASS:'var(--pass)',ERROR:'var(--error)','NO-RESPONSE':'var(--noresp)',EXCLUDED:'var(--excl)',UNCLICKABLE:'var(--excl)'};
let filter = 'ALL', current = null;
const $ = id => document.getElementById(id);
function toast(m){const t=$('toast');t.textContent=m;t.classList.add('on');setTimeout(()=>t.classList.remove('on'),2000);}
function setFilter(f){
  filter=f;
  document.querySelectorAll('.chip').forEach(c=>c.classList.toggle('active',c.dataset.f===f));
  renderRows();
}
function filtered(){
  const q=$('search').value.trim().toLowerCase();
  return DATA.filter(d=>{
    if(filter!=='ALL'&&d.status!==filter)return false;
    if(q&&!(d.label.toLowerCase().includes(q)||d.sel.toLowerCase().includes(q)||(d.page||'').toLowerCase().includes(q)))return false;
    return true;
  });
}
function sigHtml(d){
  if(d.status==='EXCLUDED'||d.status==='UNCLICKABLE')return '<span class="sig">—</span>';
  return Object.entries(SIGLABEL).map(([k,label])=>{
    const v=d.signals?.[k];
    const cls=(k==='console'&&v&&d.status==='ERROR')?'err':(v?'hit':'miss');
    return '<span class="sig '+cls+'">'+label+'</span>';
  }).join('');
}
function rowHtml(d){
  return '<div class="lrow" onclick="openDrawer('+d._idx+')">'
    +'<div><span class="badge '+d.status+'">'+d.status+'</span></div>'
    +'<div><span class="sev '+d._sev+'">'+d._sev+'</span></div>'
    +'<div><div class="el-label">'+esc(d.label)+'</div><div class="el-loc">'+esc(d.sel)+'</div></div>'
    +'<div class="signals">'+sigHtml(d)+'</div>'
    +'<div class="repro">'+esc(d._repro)+'</div></div>';
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function renderRows(){
  const rows=filtered();
  if(!rows.length){$('list').innerHTML='<div class="empty">해당 조건의 결과가 없습니다.</div>';return;}
  const pages=[...new Set(rows.map(d=>d.page))];
  const headHtml='<div class="lhead"><div>상태</div><div>심각도</div><div>요소</div><div>감지 신호</div><div>재현</div></div>';
  $('list').innerHTML=pages.map(p=>{
    const items=rows.filter(d=>d.page===p);
    const c={PASS:0,ERROR:0,'NO-RESPONSE':0,EXCLUDED:0};
    items.forEach(d=>{c[d.status]=(c[d.status]||0)+1;});
    const mini=['PASS','ERROR','NO-RESPONSE','EXCLUDED'].filter(s=>c[s]).map(s=>{
      const bg={PASS:'var(--pass-bg)',ERROR:'var(--error-bg)','NO-RESPONSE':'var(--noresp-bg)',EXCLUDED:'var(--excl-bg)'}[s];
      return '<span style="background:'+bg+';color:'+STCOLOR[s]+';padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700">'+c[s]+'</span>';
    }).join('');
    return '<div class="grphead">📄 <span>'+esc(p)+'</span><span class="u">· '+items.length+'개 요소</span><div class="mini">'+mini+'</div></div>'
      +headHtml+items.map(rowHtml).join('');
  }).join('');
}
function openDrawer(idx){
  const d=DATA[idx];current=d;
  $('dTitle').textContent=d.label;
  $('dSub').textContent=(d.page||'')+' '+d.sel;
  const sigRows=d.status!=='EXCLUDED'&&d.status!=='UNCLICKABLE'
    ?'<div class="dsec"><div class="t">감지 신호</div><div class="signals">'+Object.entries(SIGLABEL).map(([k,label])=>{const v=d.signals?.[k];const cls=(k==='console'&&v&&d.status==='ERROR')?'err':(v?'hit':'miss');return '<span class="sig '+cls+'">'+label+' '+(v?'✓':'✗')+'</span>';}).join('')+'</div></div>':''
  $('dBody').innerHTML='<div class="dsec"><div class="t">판정</div>'
    +'<div class="kv"><span class="k">상태</span><span class="v"><span class="badge '+d.status+'">'+d.status+'</span></span></div>'
    +'<div class="kv"><span class="k">심각도</span><span class="v">'+d._sev+'</span></div>'
    +'<div class="kv"><span class="k">페이지</span><span class="v">'+esc(d.page||'')+'</span></div>'
    +'<div class="kv"><span class="k">증상</span><span class="v">'+esc(d._repro)+'</span></div></div>'
    +sigRows
    +'<div class="dsec"><div class="t">Selector</div><div class="code">'+esc(d.sel)+'<button class="cp" onclick="copySelector()">copy</button></div></div>';
  $('drawer').classList.add('on');$('overlay').classList.add('on');
}
function closeDrawer(){$('drawer').classList.remove('on');$('overlay').classList.remove('on');}
function copySelector(){if(!current)return;navigator.clipboard?.writeText(current.sel);toast('Selector 복사됨');}
function copyTicket(){
  if(!current)return;
  const t='['+current.status+'/'+current._sev+'] '+current.label+' — '+current.page+'\\nSelector: '+current.sel+'\\n증상: '+current._repro;
  navigator.clipboard?.writeText(t);toast('이슈 티켓 형식으로 복사됨');
}
function exportExcel(){
  const c={PASS:0,ERROR:0,'NO-RESPONSE':0,EXCLUDED:0};
  DATA.forEach(d=>{c[d.status]=(c[d.status]||0)+1;});
  const tested=c.PASS+c.ERROR+c['NO-RESPONSE'];
  const summary=[['항목','값'],['URL','${esc(meta.url)}'],['검사 시각','${esc(meta.scannedAt)}'],
    ['페이지 수',${pages.length}],['총 요소',DATA.length],['PASS',c.PASS],['ERROR',c.ERROR],['NO-RESPONSE',c['NO-RESPONSE']],['EXCLUDED',c.EXCLUDED],
    ['Pass율',(tested?Math.round(c.PASS/tested*100):0)+'%']];
  const detail=[['페이지','상태','심각도','요소','Selector','DOM','NET','URL','CON','증상']];
  DATA.forEach(d=>detail.push([d.page,d.status,d._sev,d.label,d.sel,d.signals?.dom??'',d.signals?.net??'',d.signals?.url??'',d.signals?.console??'',d._repro]));
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(summary),'요약');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(detail),'상세');
  XLSX.writeFile(wb,'smoke-report.xlsx');
  toast('Excel 저장됨');
}
</script>
</body>
</html>`;
}

function saveHtml(results, meta, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const html = buildHtml(results, meta);
  const filePath = path.join(outputDir, 'smoke-report.html');
  fs.writeFileSync(filePath, html, 'utf8');
  return filePath;
}

function saveExcel(results, meta, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const c = counts(results);
  const tested = c.PASS + c.ERROR + c['NO-RESPONSE'];
  const pages = [...new Set(results.map(d => d.page))];

  const summary = [
    ['항목', '값'],
    ['URL', meta.url],
    ['검사 시각', meta.scannedAt],
    ['스캔 범위', meta.scope],
    ['검사 페이지 수', pages.length],
    ['총 요소', results.length],
    ['PASS', c.PASS],
    ['ERROR', c.ERROR],
    ['NO-RESPONSE', c['NO-RESPONSE']],
    ['EXCLUDED', c.EXCLUDED],
    ['Pass율', (tested ? Math.round(c.PASS / tested * 100) : 0) + '%'],
    ['소요 시간', meta.elapsed + 's'],
  ];

  const detail = [['페이지', '상태', '심각도', '요소', 'Selector', 'DOM', 'NET', 'URL', 'CON', '증상']];
  results.forEach(d => detail.push([
    d.page, d.status, severity(d), d.label, d.sel,
    d.signals?.dom ?? '', d.signals?.net ?? '', d.signals?.url ?? '', d.signals?.console ?? '',
    d.reason || reproText(d),
  ]));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), '요약');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), '상세');
  const filePath = path.join(outputDir, 'smoke-report.xlsx');
  XLSX.writeFile(wb, filePath);
  return filePath;
}

module.exports = { saveHtml, saveExcel };
