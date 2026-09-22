/**
 * 버그 데모 사이트 회귀 테스트 — 결함 탐지 · 스크린샷
 *
 * test-buggy.html · test-buggy-2.html 은 실제 서비스처럼 생긴 화면에 버그를 심어 둔 곳이다.
 * 각 요소의 data-expect 가 기대 판정이다. 두 페이지를 한 스크린샷 폴더로 검사해
 *   1) 판정이 기대값과 맞는지
 *   2) 결함마다 스크린샷이 따로 남는지 (페이지끼리 덮어쓰지 않는지)
 * 를 확인한다.
 *
 * 실행: npm test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { scanPage, waitForContent } = require('../src/engine');
const { explainClick } = require('../src/explain');

const PORT = Number(process.env.TEST_PORT_BUGGY) || 3989;
const PAGES = ['/test-buggy.html', '/test-buggy-2.html'].map(p => `http://127.0.0.1:${PORT}${p}`);

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      require('http').get(`http://127.0.0.1:${PORT}/api/health`, res => {
        res.resume();
        res.statusCode === 200 ? resolve() : retry();
      }).on('error', retry);
    };
    const retry = () => {
      if (Date.now() - t0 > timeoutMs) return reject(new Error('서버가 시작되지 않았습니다.'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

(async () => {
  console.log(`\n  ${C.b}ER 버그 데모 사이트 검증${C.x}`);
  console.log(`  ${C.d}대상 ${PAGES.join(' · ')}${C.x}\n`);

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-buggy-'));

  let browser, failed = 0, total = 0;
  const check = (ok, msg, why = '') => {
    total++;
    if (!ok) failed++;
    console.log(`  ${ok ? `${C.g}✓` : `${C.r}✗`}${C.x} ${msg}${why ? `  ${C.d}${why}${C.x}` : ''}`);
  };

  try {
    await waitForServer();
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const t0 = Date.now();
    const all = [];
    for (const url of PAGES) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // 크롤러처럼 화면이 다 불러와진 뒤에 검사를 시작한다
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await waitForContent(page);
      // 검사가 화면을 바꾸기 전에 기대값을 읽어 둔다
      // data-reason 이 있으면 판정 근거에 그 말이 들어 있어야 한다 — 판정은 맞는데 엉뚱한 이유(배경 에러 등)로 맞힌 경우를 거른다
      const expect = await page.$$eval('[data-expect]', els => els.map(el => ({ id: el.id, want: el.dataset.expect, reason: el.dataset.reason || '' })));
      const results = await scanPage(page, url, { observeMs: 2000, screenshotDir: shotDir });
      all.push(...results);

      console.log(`  ${C.b}${new URL(url).pathname}${C.x}`);
      for (const { id, want, reason } of expect) {
        const got = results.find(r => r.sel && new RegExp(`#${id}$`).test(r.sel));
        const actual = got ? got.status : '(검사 안 됨)';
        const why = got?.reason || '';
        check(actual === want && why.includes(reason), `${id.padEnd(14)} ${want.padEnd(12)} → ${actual}`,
          why.slice(0, 50) + (reason && !why.includes(reason) ? `  (근거에 "${reason}" 이 있어야 함)` : ''));
      }
      console.log('');
    }

    console.log(`  ${C.b}스크린샷${C.x}`);
    const defects = all.filter(r => r.status === 'ERROR' || r.status === 'NO-RESPONSE');
    const missing = defects.filter(r => !r.screenshot || !fs.existsSync(path.join(shotDir, r.screenshot)));
    check(missing.length === 0, `결함 ${defects.length}건 모두 스크린샷 있음`, missing.map(r => r.label).join(', '));
    const names = new Set(defects.map(r => r.screenshot));
    check(names.size === defects.length, `스크린샷 이름이 서로 다름 (${names.size}/${defects.length})`,
      names.size === defects.length ? '' : '다른 페이지 결함이 같은 파일을 덮어씀');
    check(fs.readdirSync(shotDir).length === defects.length, `저장된 파일 수 = 결함 수 (${fs.readdirSync(shotDir).length})`);

    console.log(`\n  ${C.b}원인 안내 문구${C.x}`);
    // 클릭 대상 태그가 먼저 찍혀도, 덮은 요소의 이름을 대야 한다
    const msg = explainClick([
      'locator.click: Timeout 2500ms exceeded.',
      '  - locator resolved to <span id="fakeBtn" class="fake" role="button">엑셀 내보내기</span>',
      '    - <div id="overlay" class="backdrop">…</div> intercepts pointer events',
    ].join('\n'));
    check(msg.startsWith('<div class="backdrop">'), '가린 요소 이름을 정확히 댄다', msg);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ${'─'.repeat(70)}`);
    console.log(failed === 0
      ? `  ${C.g}${C.b}통과 ${total}/${total}${C.x} — 소요 ${elapsed}s\n`
      : `  ${C.r}${C.b}실패 ${failed}/${total}${C.x} — 소요 ${elapsed}s\n`);
  } catch (e) {
    console.error(`\n  ${C.r}검증 실행 오류: ${e.message}${C.x}\n`);
    failed = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
    fs.rmSync(shotDir, { recursive: true, force: true });
  }

  process.exit(failed === 0 ? 0 : 1);
})();
