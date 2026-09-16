/**
 * 리포트 생성 — 공유·보고용 HTML 과 이슈 첨부용 Excel
 *
 * HTML 은 단일 파일로 열리며 인쇄(PDF 저장)까지 고려한다.
 * 스크린샷은 같은 폴더의 shots/ 를 상대경로로 참조하므로, 폴더째 공유해야 이미지가 보인다.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const NAME = {
  ERROR: '에러', 'NO-RESPONSE': '무감', PASS: '정상',
  EXCLUDED: '검사 제외', UNCLICKABLE: '클릭 불가',
};
const SIGNAL = { dom: '화면 구조', net: '서버 요청', url: '주소 이동', vis: '화면 표시', scroll: '스크롤', popup: '새 창', console: 'JS 예외' };
const ORDER = { ERROR: 0, 'NO-RESPONSE': 1, UNCLICKABLE: 2, PASS: 3, EXCLUDED: 4 };

function counts(list) {
  const c = { PASS: 0, ERROR: 0, 'NO-RESPONSE': 0, EXCLUDED: 0, UNCLICKABLE: 0 };
  list.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
  return c;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function cls(status) { return status === 'NO-RESPONSE' ? 'nr' : status.toLowerCase(); }

function buildHtml(results, meta) {
  const c = counts(results);
  const defects = c.ERROR + c['NO-RESPONSE'];
  const tested = c.PASS + c.ERROR + c['NO-RESPONSE'];
  const rate = tested ? Math.round(c.PASS / tested * 100) : 0;
  const pages = [...new Set(results.map(r => r.page))];

  const strip = results.map(r =>
    `<i class="c-${cls(r.status)}" title="${esc(NAME[r.status] || r.status)} — ${esc(r.label)}"></i>`).join('');

  const groups = pages.map(page => {
    const items = results.filter(r => r.page === page)
      .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
    const gc = counts(items);
    const bad = gc.ERROR + gc['NO-RESPONSE'];
    const rows = items.map(r => `
      <tr class="r-${cls(r.status)}">
        <td><span class="tag t-${cls(r.status)}">${esc(NAME[r.status] || r.status)}</span></td>
        <td><div class="lbl">${esc(r.label)}</div><div class="sel">${esc(r.sel)}</div></td>
        <td class="why">${esc(r.reason || '')}</td>
        <td class="sig">${r.signals && Object.keys(r.signals).length
          ? Object.entries(SIGNAL).filter(([k]) => r.signals[k]).map(([k, n]) => `<span class="${k === 'console' ? 'bad' : ''}">${n}</span>`).join('') || '—'
          : '—'}</td>
        <td class="shot">${r.screenshot ? `<a href="shots/${encodeURIComponent(r.screenshot)}" target="_blank">화면</a>` : ''}</td>
      </tr>`).join('');
    return `
    <section class="grp">
      <h2>${esc(page)}<span>${bad ? `결함 ${bad}건 · ` : ''}요소 ${items.length}개</span></h2>
      <table>
        <thead><tr><th style="width:96px">판정</th><th>요소</th><th style="width:26%">근거</th><th style="width:19%">관찰된 신호</th><th style="width:52px"></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ER 검사 리포트 — ${esc(meta.url)}</title>
<style>
  :root{--ink:#16181d;--ink2:#59606f;--ink3:#8d94a5;--line:#e4e7ec;--line2:#eef1f4;
    --er:#c62a1f;--er-bg:#fdeeec;--nr:#b3620a;--nr-bg:#fdf3e5;--ok:#0d7a51;--ok-bg:#e8f5ef;--ex:#98a0b0;--ex-bg:#f1f3f5;
    --code:ui-monospace,'SF Mono',Menlo,Consolas,monospace}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;
    color:var(--ink);line-height:1.55;font-size:14px;background:#fff;padding:34px 30px;max-width:1120px;margin:0 auto}
  h1{font-size:34px;font-weight:760;letter-spacing:-.03em}
  h1 em{font-style:normal;color:var(--er)}
  h1.clean{color:var(--ok)}
  .meta{color:var(--ink2);margin-top:7px;font-size:13.5px}
  .meta code{font-family:var(--code);color:var(--ink)}
  .strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(8px,26px));gap:3px;justify-content:start;margin:22px 0 9px}
  .strip i{height:24px;border-radius:2px;display:block}
  .c-error{background:var(--er)}.c-nr{background:var(--nr)}.c-pass{background:#9ed3bb}
  .c-excluded,.c-unclickable{background:#dfe3e8}
  .legend{display:flex;gap:15px;flex-wrap:wrap;color:var(--ink2);font-size:12.5px;margin-bottom:26px}
  .legend span{display:inline-flex;align-items:center;gap:6px}
  .legend i{width:10px;height:10px;border-radius:2px}
  .sum{display:flex;gap:26px;flex-wrap:wrap;padding:15px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
  .sum div{font-size:13px;color:var(--ink2)}
  .sum b{display:block;font-size:22px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
  .sum .e b{color:var(--er)}.sum .n b{color:var(--nr)}.sum .p b{color:var(--ok)}
  .grp{margin-top:30px}
  .grp h2{font-size:13.5px;font-family:var(--code);color:var(--ink);padding-bottom:9px;border-bottom:1px solid var(--line);
    display:flex;gap:12px;align-items:baseline;word-break:break-all}
  .grp h2 span{margin-left:auto;font-family:inherit;color:var(--ink2);font-size:12.5px;white-space:nowrap}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:12px;color:var(--ink3);font-weight:600;padding:9px 10px 9px 0;border-bottom:1px solid var(--line2)}
  td{padding:11px 10px 11px 0;border-bottom:1px solid var(--line2);vertical-align:top}
  tr.r-error td:first-child,tr.r-nr td:first-child{border-left:3px solid transparent}
  .tag{font-size:12px;font-weight:650;padding:3px 8px;border-radius:5px;display:inline-block;white-space:nowrap}
  .t-error{background:var(--er-bg);color:var(--er)}
  .t-nr{background:var(--nr-bg);color:var(--nr)}
  .t-pass{background:var(--ok-bg);color:var(--ok)}
  .t-excluded,.t-unclickable{background:var(--ex-bg);color:var(--ex)}
  .lbl{font-weight:600}
  .sel{font-family:var(--code);font-size:12px;color:var(--ink3);margin-top:2px;word-break:break-all}
  .why{color:var(--ink2);font-size:13px}
  tr.r-error .why{color:var(--er)}
  .sig span{display:inline-block;font-size:11.5px;background:var(--ok-bg);color:var(--ok);border-radius:4px;padding:2px 6px;margin:0 3px 3px 0}
  .sig span.bad{background:var(--er-bg);color:var(--er)}
  .shot a{font-size:12px;color:var(--ink2)}
  footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);color:var(--ink3);font-size:12.5px;line-height:1.7}
  @media print{body{padding:0;font-size:11.5px}.grp{break-inside:auto}tr{break-inside:avoid}h1{font-size:26px}}
</style></head>
<body>
  <h1 class="${defects ? '' : 'clean'}">${defects ? `결함 <em>${defects}건</em>` : (tested ? '결함 없음' : '검사한 요소 없음')}</h1>
  <p class="meta"><code>${esc(meta.url)}</code> · ${esc(meta.scannedAt)} 검사 · ${esc(meta.elapsed)}초 소요 · 범위 ${esc(meta.scope)}${meta.stopped ? ' · 중단됨' : ''}</p>

  <div class="strip">${strip}</div>
  <div class="legend">
    <span><i style="background:var(--er)"></i>에러</span>
    <span><i style="background:var(--nr)"></i>무감</span>
    <span><i style="background:#9ed3bb"></i>정상</span>
    <span><i style="background:#dfe3e8"></i>검사 제외</span>
  </div>

  <div class="sum">
    <div class="e">에러<b>${c.ERROR}</b></div>
    <div class="n">무감<b>${c['NO-RESPONSE']}</b></div>
    <div class="p">정상<b>${c.PASS}</b></div>
    <div>검사 제외<b>${c.EXCLUDED + c.UNCLICKABLE}</b></div>
    <div>정상 비율<b>${rate}%</b></div>
    <div>검사 페이지<b>${pages.length}</b></div>
  </div>

  ${groups}

  <footer>
    ER — 클릭 후 화면·서버 요청·주소 변화를 관찰해 판정합니다. Playwright 기반.<br>
    반응이 있는지만 판정합니다. 그 반응이 기획과 맞는지는 사람이 확인해야 합니다.
  </footer>
</body></html>`;
}

/**
 * Markdown 리포트 — 이슈 티켓·위키·메신저에 그대로 붙여넣기 위한 형식
 */
function buildMarkdown(results, meta) {
  const c = counts(results);
  const defects = c.ERROR + c['NO-RESPONSE'];
  const tested = c.PASS + c.ERROR + c['NO-RESPONSE'];
  const rate = tested ? Math.round(c.PASS / tested * 100) : 0;
  const pages = [...new Set(results.map(r => r.page))];
  const esc = t => String(t ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

  const out = [];
  out.push(`# 자동 스모크 테스트 결과`);
  out.push('');
  out.push(defects ? `**결함 ${defects}건**` : (tested ? '**결함 없음**' : '**검사한 요소 없음**'));
  out.push('');
  out.push('| 항목 | 값 |');
  out.push('|---|---|');
  out.push(`| 검사 대상 | ${esc(meta.url)} |`);
  out.push(`| 검사 일시 | ${esc(meta.scannedAt)} |`);
  out.push(`| 검사 범위 | ${esc(meta.scope)} |`);
  out.push(`| 검사 페이지 | ${pages.length}개 |`);
  out.push(`| 검사 요소 | ${results.length}개 |`);
  out.push(`| 에러 / 무감 / 정상 / 제외 | ${c.ERROR} / ${c['NO-RESPONSE']} / ${c.PASS} / ${c.EXCLUDED + c.UNCLICKABLE} |`);
  out.push(`| 정상 비율 | ${rate}% |`);
  out.push(`| 소요 시간 | ${esc(meta.elapsed)}초 |`);
  if (meta.filterLabel) out.push(`| 내보낸 범위 | ${esc(meta.filterLabel)} |`);
  out.push('');

  for (const page of pages) {
    const items = results.filter(r => r.page === page)
      .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
    const gc = counts(items);
    const bad = gc.ERROR + gc['NO-RESPONSE'];
    out.push(`## ${esc(page)}`);
    out.push('');
    out.push(bad ? `결함 ${bad}건 · 요소 ${items.length}개` : `요소 ${items.length}개`);
    out.push('');
    out.push('| 판정 | 요소 | 선택자 | 판정 근거 |');
    out.push('|---|---|---|---|');
    for (const r of items) {
      out.push(`| ${NAME[r.status] || r.status} | ${esc(r.label)} | \`${esc(r.sel)}\` | ${esc(r.reason || '')} |`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('반응이 있는지만 판정합니다. 그 반응이 기획과 맞는지는 사람이 확인해야 합니다.');
  out.push('');
  return out.join('\n');
}

function saveMarkdown(results, meta, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, 'smoke-report.md');
  fs.writeFileSync(filePath, buildMarkdown(results, meta), 'utf8');
  return filePath;
}

function saveHtml(results, meta, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, 'smoke-report.html');
  fs.writeFileSync(filePath, buildHtml(results, meta), 'utf8');
  return filePath;
}

function saveExcel(results, meta, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const c = counts(results);
  const tested = c.PASS + c.ERROR + c['NO-RESPONSE'];
  const pages = [...new Set(results.map(r => r.page))];

  const summary = [
    ['항목', '값'],
    ['검사 대상', meta.url],
    ['검사 시각', meta.scannedAt],
    ['검사 범위', meta.scope],
    ['검사 페이지 수', pages.length],
    ['검사 요소 수', results.length],
    ['에러', c.ERROR],
    ['무감', c['NO-RESPONSE']],
    ['정상', c.PASS],
    ['검사 제외', c.EXCLUDED + c.UNCLICKABLE],
    ['결함 합계', c.ERROR + c['NO-RESPONSE']],
    ['정상 비율', (tested ? Math.round(c.PASS / tested * 100) : 0) + '%'],
    ['소요 시간', meta.elapsed + '초'],
    ...(meta.stopped ? [['비고', '사용자가 중단한 검사입니다']] : []),
  ];

  const header = ['페이지', '판정', '요소', '선택자', '판정 근거',
    ...Object.values(SIGNAL), '관찰 시간(초)', '스크린샷'];
  const detail = [header];
  results
    .slice()
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9))
    .forEach(r => detail.push([
      r.page, NAME[r.status] || r.status, r.label, r.sel, r.reason || '',
      ...Object.keys(SIGNAL).map(k => (r.signals?.[k] ? 'O' : '')),
      r.observedMs ? (r.observedMs / 1000).toFixed(1) : '',
      r.screenshot ? `shots/${r.screenshot}` : '',
    ]));

  const wb = XLSX.utils.book_new();
  const wsSum = XLSX.utils.aoa_to_sheet(summary);
  wsSum['!cols'] = [{ wch: 16 }, { wch: 52 }];
  XLSX.utils.book_append_sheet(wb, wsSum, '요약');

  const wsDet = XLSX.utils.aoa_to_sheet(detail);
  wsDet['!cols'] = [{ wch: 40 }, { wch: 10 }, { wch: 30 }, { wch: 28 }, { wch: 44 },
    ...Object.keys(SIGNAL).map(() => ({ wch: 9 })), { wch: 12 }, { wch: 22 }];
  wsDet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: detail.length - 1, c: header.length - 1 } }) };
  wsDet['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, wsDet, '상세');

  const filePath = path.join(outputDir, 'smoke-report.xlsx');
  XLSX.writeFile(wb, filePath);
  return filePath;
}

module.exports = { saveHtml, saveExcel, saveMarkdown, buildHtml, buildMarkdown };
