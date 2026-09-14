/**
 * 자동 스모크 테스트 CLI
 * 사용: node scan.js <URL> [--scope page|path|domain] [--login] [--observe 2000]
 */
const { chromium } = require('playwright');
const { doLogin } = require('./src/login');
const { crawl } = require('./src/crawler');
const { saveHtml, saveExcel } = require('./src/reporter');
const cfg = require('./config.json');
const path = require('path');

const args = process.argv.slice(2);
const targetUrl = args.find(a => !a.startsWith('--'));
if (!targetUrl) {
  console.error('사용법: node scan.js <URL> [--scope page|path|domain] [--login] [--observe 2000]');
  process.exit(1);
}

// CLI 옵션 파싱
const scopeIdx = args.indexOf('--scope');
const scope = scopeIdx !== -1 ? args[scopeIdx + 1] : cfg.scope ?? 'path';
const useLogin = args.includes('--login') || (cfg.login?.enabled === true);
const observeIdx = args.indexOf('--observe');
if (observeIdx !== -1) cfg.observeMs = parseInt(args[observeIdx + 1], 10);

const outputDir = path.resolve(cfg.outputDir ?? 'report');

(async () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Smoke — 자동 스모크 테스트');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  대상: ${targetUrl}`);
  console.log(`  범위: ${scope}  |  observeMs: ${cfg.observeMs}ms`);
  console.log('');

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: cfg.ignoreHTTPSErrors ?? true });
  const page = await context.newPage();

  // 로그인
  if (useLogin && cfg.login?.username) {
    try {
      await doLogin(page, cfg.login);
    } catch (e) {
      console.error(`로그인 실패: ${e.message}`);
      await browser.close();
      process.exit(1);
    }
  } else {
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 20000 });
  }

  const t0 = Date.now();
  let pageCount = 0;

  const results = await crawl(browser, targetUrl, scope, ({ type, url, count }) => {
    if (type === 'page') {
      pageCount++;
      console.log(`  [${pageCount}] 스캔 중: ${url}`);
    }
    if (type === 'done') {
      console.log(`       → ${count}개 요소 검사 완료`);
    }
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  await browser.close();

  // 집계
  const c = { PASS: 0, ERROR: 0, 'NO-RESPONSE': 0, EXCLUDED: 0, UNCLICKABLE: 0 };
  results.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
  const tested = c.PASS + c.ERROR + c['NO-RESPONSE'];
  const rate = tested ? Math.round(c.PASS / tested * 100) : 0;

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  총 ${results.length}개 요소 · ${pageCount}개 페이지 · ${elapsed}s`);
  console.log(`  PASS ${c.PASS}  ERROR ${c.ERROR}  NO-RESPONSE ${c['NO-RESPONSE']}  EXCLUDED ${c.EXCLUDED}`);
  console.log(`  Pass율: ${rate}%`);
  console.log('');

  const scannedAt = new Date().toLocaleString('ko-KR');
  const meta = { url: targetUrl, scope, elapsed, scannedAt };

  const htmlPath = saveHtml(results, meta, outputDir);
  const xlsxPath = saveExcel(results, meta, outputDir);

  console.log(`  리포트 저장:`);
  console.log(`    HTML  → ${htmlPath}`);
  console.log(`    Excel → ${xlsxPath}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
})();
