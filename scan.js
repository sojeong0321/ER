#!/usr/bin/env node
/**
 * ER — 자동 스모크 테스트 CLI
 *
 * 사용: node scan.js <URL> [옵션]
 *   --scope page|path|domain   검사 범위 (기본: config.json)
 *   --observe <ms>             요소당 최대 관찰 시간
 *   --max-pages <n>            최대 순회 페이지 수
 *   --exclude "삭제,결제"       제외 규칙 (쉼표 구분)
 *   --login                    config.json 의 로그인 정보 사용
 *   --out <dir>                리포트 저장 경로
 *   --quiet                    요약만 출력
 */
const { chromium } = require('playwright');
const path = require('path');
const { doLogin, readSession } = require('./src/login');
const { crawl } = require('./src/crawler');
const { saveHtml, saveExcel } = require('./src/reporter');
const cfg = require('./config.json');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const targetUrl = args.find(a => !a.startsWith('--') && !isOptionValue(a));
function isOptionValue(a) {
  const i = args.indexOf(a);
  return i > 0 && ['--scope', '--observe', '--max-pages', '--exclude', '--out'].includes(args[i - 1]);
}

if (!targetUrl || has('--help') || has('-h')) {
  console.log(`
  ER — 자동 스모크 테스트

  사용법:
    node scan.js <URL> [옵션]

  옵션:
    --scope page|path|domain   검사 범위 (기본: ${cfg.scope})
    --observe <ms>             요소당 최대 관찰 시간 (기본: ${cfg.observeMs})
    --max-pages <n>            최대 순회 페이지 수 (기본: ${cfg.maxPages})
    --exclude "삭제,결제"       제외 규칙 (기본: ${(cfg.excludeRules || []).join(',')})
    --login                    config.json 의 로그인 정보 사용
    --session                  저장된 로그인 사용 (npm run login 으로 미리 저장)
    --out <dir>                리포트 저장 경로 (기본: ${cfg.outputDir})
    --quiet                    요약만 출력

  예시:
    node scan.js https://example.com
    node scan.js http://localhost:8080 --scope domain --observe 1500
`);
  process.exit(targetUrl ? 0 : 1);
}

// ── 옵션 조립 (이전 버전은 이 옵션들을 crawl 에 넘기지 않아 전부 무시됐다) ──
const scope = val('--scope', cfg.scope ?? 'path');
const observeMs = parseInt(val('--observe', cfg.observeMs ?? 2000), 10);
const maxPages = parseInt(val('--max-pages', cfg.maxPages ?? 50), 10);
const excludeRules = val('--exclude', (cfg.excludeRules || []).join(','))
  .split(',').map(s => s.trim()).filter(Boolean);
const useLogin = has('--login') || cfg.login?.enabled === true;
const useSession = has('--session');
const outputDir = path.resolve(val('--out', cfg.outputDir ?? 'report'));
const quiet = has('--quiet');

const C = {
  PASS: '\x1b[32m', ERROR: '\x1b[31m', 'NO-RESPONSE': '\x1b[33m',
  EXCLUDED: '\x1b[90m', UNCLICKABLE: '\x1b[90m', reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
};
const color = (s, t) => `${C[s] || ''}${t}${C.reset}`;

(async () => {
  console.log('');
  console.log(`  ${C.bold}ER — 자동 스모크 테스트${C.reset}`);
  console.log(`  ${C.dim}대상 ${targetUrl}  ·  범위 ${scope}  ·  관찰 ${observeMs}ms${C.reset}`);
  console.log('');

  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (e) {
    const m = String(e?.message || e);
    if (/Executable doesn't exist|Please run the following command/i.test(m)) {
      console.error(`  브라우저(Chromium)가 없습니다. 아래를 먼저 실행하세요.\n\n    npx playwright install chromium\n`);
    } else {
      console.error(`  브라우저를 시작하지 못했습니다: ${m.split('\n')[0]}`);
    }
    process.exit(1);
  }

  let storageState;
  if (useSession) {
    const saved = readSession();
    if (!saved) {
      console.error('  저장된 로그인이 없습니다. 먼저 실행하세요:\n\n    npm run login <로그인 주소>\n');
      await browser.close();
      process.exit(1);
    }
    storageState = saved.state;
    console.log(`  ${C.dim}저장된 로그인 사용 (${new Date(saved.savedAt).toLocaleString('ko-KR')} 저장)${C.reset}`);
  }

  const context = await browser.newContext({
    ignoreHTTPSErrors: cfg.ignoreHTTPSErrors !== false,
    acceptDownloads: false,
    viewport: { width: 1440, height: 900 },
    ...(storageState ? { storageState } : {}),
  });
  const page = await context.newPage();

  if (!useSession && useLogin && cfg.login?.username) {
    try {
      await doLogin(page, cfg.login);
    } catch (e) {
      console.error(`  로그인 실패: ${e.message}`);
      await browser.close();
      process.exit(1);
    }
  }

  const t0 = Date.now();
  let pageNo = 0;

  const results = await crawl(browser, targetUrl, scope, ev => {
    if (quiet) return;
    if (ev.type === 'page') { pageNo++; console.log(`  ${C.dim}[${pageNo}]${C.reset} ${ev.url}`); }
    if (ev.type === 'done') console.log(`      ${C.dim}→ ${ev.count}개 요소 검사 완료${C.reset}`);
    if (ev.type === 'pageError') console.log(`      ${color('ERROR', '접근 실패')} ${ev.msg}`);
    if (ev.type === 'limit') console.log(`  ${C.dim}최대 페이지 수(${ev.max}) 도달 — ${ev.skipped}개 건너뜀${C.reset}`);
  }, { observeMs, excludeRules, maxPages, screenshotDir: ensureDir(path.join(outputDir, 'shots')) });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  await browser.close();

  // ── 집계 ──
  const c = { PASS: 0, ERROR: 0, 'NO-RESPONSE': 0, EXCLUDED: 0, UNCLICKABLE: 0 };
  results.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
  const tested = c.PASS + c.ERROR + c['NO-RESPONSE'];
  const rate = tested ? Math.round(c.PASS / tested * 100) : 0;

  // ── 결함 목록 ──
  const defects = results.filter(r => r.status === 'ERROR' || r.status === 'NO-RESPONSE');
  if (defects.length && !quiet) {
    console.log('');
    console.log(`  ${C.bold}발견된 결함 ${defects.length}건${C.reset}`);
    for (const d of defects) {
      console.log(`    ${color(d.status, d.status.padEnd(12))} ${d.label.slice(0, 32).padEnd(34)} ${C.dim}${d.reason || ''}${C.reset}`);
    }
  }

  console.log('');
  console.log(`  총 ${results.length}개 요소 · ${pageNo}개 페이지 · ${elapsed}s`);
  console.log(`  ${color('PASS', `PASS ${c.PASS}`)}  ${color('ERROR', `ERROR ${c.ERROR}`)}  ${color('NO-RESPONSE', `NO-RESPONSE ${c['NO-RESPONSE']}`)}  ${color('EXCLUDED', `EXCLUDED ${c.EXCLUDED + c.UNCLICKABLE}`)}`);
  console.log(`  Pass율 ${rate}%`);
  console.log('');

  const meta = { url: targetUrl, scope, elapsed, scannedAt: new Date().toLocaleString('ko-KR') };
  const htmlPath = saveHtml(results, meta, outputDir);
  const xlsxPath = saveExcel(results, meta, outputDir);
  console.log(`  리포트  ${C.dim}${htmlPath}${C.reset}`);
  console.log(`          ${C.dim}${xlsxPath}${C.reset}`);
  console.log('');

  // 결함이 있으면 1로 종료 — CI 파이프라인에서 게이트로 쓸 수 있다
  process.exit(defects.length > 0 ? 1 : 0);
})().catch(e => {
  console.error(`\n  오류: ${e?.message || e}\n`);
  process.exit(2);
});

function ensureDir(p) { require('fs').mkdirSync(p, { recursive: true }); return p; }
