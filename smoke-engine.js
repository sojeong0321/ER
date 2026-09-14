/**
 * 자동 스모크 테스트 PoC 엔진
 * 핵심 증명 대상: 클릭 후 "무감(NO-RESPONSE) / 에러(ERROR) / 정상(PASS)"을 실제로 구분하는가.
 *
 * 판정 원리:
 *   클릭 직전 상태 스냅샷 → 클릭 → 관찰 대기 → 5개 신호(DOM/NET/URL/CON/VIS) 변화 수집
 *   - 콘솔 예외 or 네트워크 4xx/5xx  → ERROR
 *   - 신호 전부 무변화               → NO-RESPONSE (무감)
 *   - 신호 1개 이상 변화             → PASS
 *   - disabled/aria-disabled        → EXCLUDED
 *   - 제외 규칙(텍스트 매칭)         → EXCLUDED
 */
const { chromium } = require('playwright');

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OBSERVE_MS = 2000;          // 클릭 후 관찰 대기시간(비동기 반응 포함)
const EXCLUDE_RULES = ['삭제', '탈퇴', '결제', '로그아웃'];  // 파괴적 동작 제외

async function scan(targetUrl) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true }); // 개발 서버 자체서명 인증서 대응
  const page = await context.newPage();

  await page.goto(targetUrl, { waitUntil: 'load' });

  // clickable 요소 수집
  const handles = await page.$$('button, a, [role=button], [onclick]');
  const results = [];

  for (let i = 0; i < handles.length; i++) {
    // 매 요소마다 요소 목록이 흔들릴 수 있으니 인덱스로 재조회
    const els = await page.$$('button, a, [role=button], [onclick]');
    const el = els[i];
    if (!el) continue;

    const label = ((await el.innerText().catch(() => '')) || (await el.getAttribute('id')) || '(no-label)').trim();
    const sel = await el.evaluate(node => {
      if (node.id) return node.tagName.toLowerCase() + '#' + node.id;
      return node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).split(' ')[0] : '');
    });

    // --- EXCLUDED 사전 판정 ---
    const disabled = await el.evaluate(n => n.disabled === true || n.getAttribute('aria-disabled') === 'true');
    if (disabled) { results.push({ label, sel, status: 'EXCLUDED', reason: 'disabled 요소', signals: {} }); continue; }
    if (EXCLUDE_RULES.some(r => label.includes(r))) {
      results.push({ label, sel, status: 'EXCLUDED', reason: `제외 규칙 매칭`, signals: {} }); continue;
    }

    // --- 클릭 전 상태 스냅샷 ---
    const before = {
      html: await page.content(),
      url: page.url(),
    };
    let netHit = false, jsError = false, badResponse = false;

    const onReq = () => { netHit = true; };
    const onResp = (resp) => { if (resp.status() >= 400) badResponse = true; };
    // 콘솔 error 중 네트워크 실패(net::ERR, Failed to load resource 등)는 JS 코드 예외와 구분해 제외
    const onConsole = (msg) => {
      if (msg.type() !== 'error') return;
      const txt = msg.text();
      if (/net::ERR|Failed to load resource|ERR_|fetch/i.test(txt)) return; // 네트워크성 노이즈 제외
      jsError = true;
    };
    const onPageErr = () => { jsError = true; }; // 실제 JS 런타임 예외만
    page.on('request', onReq);
    page.on('response', onResp);
    page.on('console', onConsole);
    page.on('pageerror', onPageErr);

    // --- 클릭 실행 ---
    let clickable = true;
    try {
      await el.click({ timeout: 1000, noWaitAfter: true });
    } catch (e) {
      clickable = false;
    }

    // --- 관찰 대기 ---
    await page.waitForTimeout(OBSERVE_MS);

    page.off('request', onReq);
    page.off('response', onResp);
    page.off('console', onConsole);
    page.off('pageerror', onPageErr);

    if (!clickable) {
      results.push({ label, sel, status: 'UNCLICKABLE', reason: '클릭 불가(가려짐/이탈)', signals: {} });
      continue;
    }

    // --- 클릭 후 상태 ---
    const after = { html: await page.content(), url: page.url() };
    const domChanged = before.html !== after.html;
    const urlChanged = before.url !== after.url;

    const signals = {
      dom: domChanged ? 1 : 0,
      net: netHit ? 1 : 0,
      url: urlChanged ? 1 : 0,
      console: jsError ? 1 : 0,
    };

    // --- 판정 ---
    // ERROR = 실제 JS 예외 또는 서버 4xx/5xx 응답. 단순 네트워크 도달 실패는 ERROR로 보지 않음.
    let status;
    if (jsError || badResponse) {
      status = 'ERROR';
    } else if (!domChanged && !netHit && !urlChanged) {
      status = 'NO-RESPONSE';
    } else {
      status = 'PASS';
    }

    // URL이 바뀌었으면(라우팅) 원위치 복귀 후 이어서 검사
    if (urlChanged) {
      await page.goto(targetUrl, { waitUntil: 'load' }).catch(() => {});
    }

    results.push({ label, sel, status, signals });
  }

  await browser.close();
  return results;
}

// --- 실행 & 리포트 출력 ---
(async () => {
  const target = process.argv[2] || 'file:///home/claude/test-target.html';
  console.log('스캔 대상:', target);
  console.log('관찰 대기시간:', OBSERVE_MS + 'ms\n');

  const t0 = Date.now();
  const results = await scan(target);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);

  const c = { PASS: 0, ERROR: 0, 'NO-RESPONSE': 0, EXCLUDED: 0, UNCLICKABLE: 0 };
  results.forEach(r => c[r.status]++);

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('상태', 14) + pad('요소', 26) + '감지신호');
  console.log('-'.repeat(70));
  for (const r of results) {
    const sig = r.signals && Object.keys(r.signals).length
      ? Object.entries(r.signals).map(([k, v]) => v ? k.toUpperCase() : '·').join(' ')
      : (r.reason || '');
    console.log(pad(r.status, 14) + pad(r.label.slice(0, 24), 26) + sig);
  }
  console.log('-'.repeat(70));
  const tested = c.PASS + c.ERROR + c['NO-RESPONSE'];
  const rate = tested ? Math.round(c.PASS / tested * 100) : 0;
  console.log(`\n총 ${results.length}개 · PASS ${c.PASS} / ERROR ${c.ERROR} / NO-RESPONSE ${c['NO-RESPONSE']} / EXCLUDED ${c.EXCLUDED}`);
  console.log(`Pass율 ${rate}% · 소요 ${sec}s`);

  require('fs').writeFileSync('/home/claude/scan-result.json', JSON.stringify(results, null, 2));
})();
