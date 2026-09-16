/**
 * 판정 정확도 회귀 테스트
 *
 * test-target.html 의 각 요소는 기대 판정이 정해져 있다. 이 스크립트는 서버를 띄우고
 * 실제로 스캔한 뒤 기대값과 대조한다. 판정 로직을 건드린 뒤에는 반드시 이걸 통과해야 한다.
 *
 * 실행: npm test
 */
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { scanPage } = require('../src/engine');

const PORT = Number(process.env.TEST_PORT) || 3987;
const TARGET = `http://127.0.0.1:${PORT}/test-target.html`;

/** 요소 id → 기대 판정 */
const EXPECT = {
  'btn-dom': 'PASS',              // 클릭 시 DOM 변경
  'btn-net': 'PASS',              // 네트워크 요청 발생
  'btn-url': 'PASS',              // URL(해시) 변경
  'btn-async': 'PASS',            // 1.2초 뒤 반응 — 성급히 무감 처리하면 안 됨
  'btn-dead1': 'NO-RESPONSE',     // 핸들러 미연결 — 페이지 시계 노이즈에 속으면 PASS 로 샌다
  'btn-dead2': 'NO-RESPONSE',     // 빈 핸들러
  'btn-error': 'ERROR',           // JS 예외
  'btn-500': 'ERROR',             // 서버 500 응답
  'btn-delete': 'EXCLUDED',       // 제외 규칙('삭제')
  'btn-disabled': 'EXCLUDED',     // disabled
  'lnk-ext': 'EXCLUDED',          // 다른 사이트 링크
  'lnk-anchor': 'PASS',           // 앵커 스크롤 — 스크롤을 신호로 안 보면 무감으로 오판한다
  'lnk-js-live': 'PASS',          // javascript: 링크에 동작이 연결된 경우
  'lnk-js-dead': 'NO-RESPONSE',   // javascript: 링크인데 아무 동작도 없는 경우
  'btn-modal': 'PASS',            // 모달 표시 — 화면 변화
  'btn-popup': 'PASS',            // 새 창 열림 — 결제창처럼 창이 뜨는 것 말고는 반응이 없는 경우
  'btn-modal-close': 'PASS',      // 모달 닫기
};

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
  console.log(`\n  ${C.b}ER 판정 정확도 검증${C.x}`);
  console.log(`  ${C.d}대상 ${TARGET}${C.x}\n`);

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  let browser, failed = 0;
  try {
    await waitForServer();

    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(TARGET, { waitUntil: 'domcontentloaded' });

    const t0 = Date.now();
    const results = await scanPage(page, TARGET, {
      observeMs: 2500,
      excludeRules: ['삭제', '탈퇴', '로그아웃'],   // '결제'는 새 창 검증 대상이라 제외 목록에서 뺀다
      clickNewTab: true,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // sel('button#btn-dom') 에서 id 를 뽑아 기대값과 대조한다
    const byId = new Map();
    for (const r of results) {
      const m = /#([\w-]+)/.exec(r.sel || '');
      if (m) byId.set(m[1], r);
    }

    console.log(`  ${'요소'.padEnd(20)}${'기대'.padEnd(15)}${'실제'.padEnd(15)}판정 근거`);
    console.log(`  ${'─'.repeat(86)}`);

    for (const [id, expected] of Object.entries(EXPECT)) {
      const got = byId.get(id);
      const actual = got ? got.status : '(검사 안 됨)';
      const ok = actual === expected;
      if (!ok) failed++;
      const mark = ok ? `${C.g}✓${C.x}` : `${C.r}✗${C.x}`;
      const reason = got?.reason || '';
      console.log(`  ${mark} ${id.padEnd(18)}${expected.padEnd(15)}${(ok ? C.d : C.r) + actual.padEnd(15) + C.x}${C.d}${reason.slice(0, 40)}${C.x}`);
    }

    // 기대 목록에 없는 요소가 잡히면 테스트 페이지와 어긋난 것이므로 알린다
    const extra = [...byId.keys()].filter(id => !(id in EXPECT));
    if (extra.length) console.log(`\n  ${C.d}기대 목록에 없는 요소: ${extra.join(', ')}${C.x}`);

    console.log(`  ${'─'.repeat(86)}`);
    const total = Object.keys(EXPECT).length;
    if (failed === 0) {
      console.log(`  ${C.g}${C.b}통과 ${total}/${total}${C.x} — 오탐 0건 · 소요 ${elapsed}s\n`);
    } else {
      console.log(`  ${C.r}${C.b}실패 ${failed}/${total}${C.x} — 소요 ${elapsed}s\n`);
    }
  } catch (e) {
    console.error(`\n  ${C.r}검증 실행 오류: ${e.message}${C.x}\n`);
    failed = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }

  process.exit(failed === 0 ? 0 : 1);
})();
