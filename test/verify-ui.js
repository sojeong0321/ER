/**
 * 화면 E2E 검증 — 사람이 쓰는 흐름을 실제 브라우저로 따라간다.
 *
 *   화면별 주소·새로고침·뒤로가기 · 입력 확인 · 중복 실행 · 검사와 결과 · 연결이 끊겼을 때 ·
 *   중단 · 이력 · 프로젝트 만들기·설정·지우기 · 빈 화면
 *
 * 데이터와 리포트는 임시 폴더에 둔다. 실제 data/ · reports/ 는 건드리지 않는다.
 * 실행: npm test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PORT = Number(process.env.TEST_PORT_UI) || 3992;
const BASE = `http://127.0.0.1:${PORT}`;
const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

let total = 0, failed = 0;
function check(ok, msg, detail = '') {
  total++;
  if (!ok) failed++;
  console.log(`  ${ok ? `${C.g}✓` : `${C.r}✗`}${C.x} ${msg}${!ok && detail ? `  ${C.d}${String(detail).slice(0, 200)}${C.x}` : ''}`);
}
const section = t => console.log(`\n  ${C.b}${t}${C.x}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\n  ${C.b}ER 화면 E2E 검증${C.x}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'er-ui-'));
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ER_DATA_DIR: path.join(tmp, 'data'), ER_REPORTS_DIR: path.join(tmp, 'reports') },
    stdio: 'ignore',
  });
  let browser;
  const jsErrors = [];

  try {
    for (let t0 = Date.now(); !(await fetch(`${BASE}/api/health`).then(r => r.ok).catch(() => false));) {
      if (Date.now() - t0 > 20000) throw new Error('서버가 시작되지 않았습니다');
      await sleep(250);
    }
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const pg = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    pg.on('pageerror', e => jsErrors.push(e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) jsErrors.push(m.text()); });
    pg.on('dialog', d => d.accept());
    let scanPosts = 0;
    pg.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/scan')) scanPosts++; });

    const S = () => pg.evaluate(() => ({
      path: location.pathname, view, pid: P && P.id, running, hasResult, n: DATA.length,
      out: !document.getElementById('out').hidden, run: !document.getElementById('run').hidden,
      toast: document.getElementById('toast').textContent, err: document.getElementById('errNote').textContent,
    }));
    const waitResult = () => pg.waitForFunction(() => !running && !document.getElementById('out').hidden, null, { timeout: 120000 });
    const openMenu = async () => pg.click((await pg.$('#projSw:visible')) ? '#projSw' : '#projSwTop');

    section('주소와 화면');
    await pg.goto(BASE + '/');
    await pg.waitForFunction(() => P && location.pathname === '/p/quick');
    let s = await S();
    check(s.path === '/p/quick' && s.view === 'dash', '처음 들어오면 빠른 검사의 대시보드 주소로 바뀐다', s.path);
    await pg.goto(BASE + '/p/quick/history');
    await pg.waitForFunction(() => P);
    s = await S();
    check(s.view === 'history' && !(await pg.isHidden('#historyView')), '주소로 바로 들어와도 그 화면이 열린다');
    check(await pg.isVisible('#historyBlank'), '기록이 없으면 빈 화면 안내를 보여준다');
    await pg.click('.navitem[data-nav="dash"]');

    section('입력 확인');
    await pg.fill('#url', 'example.com');
    await pg.press('#url', 'Enter');
    await sleep(300);
    s = await S();
    check(!s.running && !s.run && /http/.test(s.toast) && scanPosts === 0, '주소 형식이 틀리면 검사를 시작하지 않고 알린다', JSON.stringify(s));

    section('검사 — 중복 실행 · 연결 끊김');
    await pg.fill('#url', `${BASE}/test-crawl/start.html`);
    await pg.press('#url', 'Enter');
    await pg.press('#url', 'Enter').catch(() => {});
    await pg.click('#goBtn', { force: true, timeout: 1000 }).catch(() => {});
    await pg.waitForFunction(() => scanId && lastSeq > 0, null, { timeout: 15000 });
    // 검사 도중 연결을 끊었다 다시 붙인다 — 결과가 빠지거나 두 번 들어오면 안 된다
    await pg.evaluate(() => { socket.disconnect(); setTimeout(() => socket.connect(), 1500); });
    await waitResult();
    await sleep(500);
    s = await S();
    check(scanPosts === 1, 'Enter 를 여러 번 눌러도 검사는 한 번만 시작된다', `요청 ${scanPosts}번`);
    const server = await pg.evaluate(() => fetch(`/api/report/${scanId}`).then(r => r.json()));
    const cells = await pg.$$eval('#liveStrip .cell', c => c.length);
    check(s.hasResult && s.n === server.results.length, '연결이 끊겼다 붙어도 결과가 모두 온다', `${s.n} / ${server.results.length}`);
    check(cells === server.results.length, '다시 받은 이벤트를 두 번 세지 않는다', `진행 칸 ${cells} / 결과 ${server.results.length}`);
    check(/끊겼습니다/.test(await pg.textContent('#term')), '연결이 끊긴 사실을 로그에 남긴다');

    section('결과 화면');
    const tabs = await pg.$$eval('#tabs .tab', t => t.map(x => x.textContent.replace(/\s+/g, '')));
    check(tabs[0].startsWith('전체') && tabs.some(t => t.startsWith('무감1')), '판정별 탭과 개수를 보여준다', tabs.join(' '));
    await pg.click('#tabs .tab[data-f="NO-RESPONSE"]');
    const items = await pg.$$eval('#list .item', l => l.length);
    const exportHref = await pg.getAttribute('#dlBox a[href*="format=xlsx"]', 'href');
    check(items === 1 && /filter=NO-RESPONSE/.test(exportHref), '탭을 고르면 목록과 내보내기 범위가 함께 바뀐다', `${items} ${exportHref}`);
    await pg.click('#list .item');
    await pg.waitForSelector('#sBody img.shot');
    const imgOk = await pg.$eval('#sBody img.shot', img => img.complete ? img.naturalWidth > 0 : new Promise(r => { img.onload = () => r(img.naturalWidth > 0); img.onerror = () => r(false); }));
    check(imgOk, '결함 상세에서 결함 발생 화면이 열린다');
    await pg.click('#copyTicket');
    await sleep(300);
    check(/복사했습니다/.test((await S()).toast), '이슈 복사 — http 로 접속해도 복사된다', (await S()).toast);
    await pg.keyboard.press('Escape');
    await pg.click('#tabs .tab[data-f="ALL"]');
    await pg.fill('#q', 'a.html');
    // 검색은 요소 이름·선택자·페이지 주소를 본다 (페이지 주소는 묶음 제목에 보인다)
    const found = await pg.$$eval('#list .item', l => l.map(x => DATA[Number(x.dataset.i)]).map(d => d.label + d.sel + d.page));
    const marks = await pg.$$eval('#list mark', m => m.map(x => x.textContent));
    check(found.length >= 1 && found.every(t => t.includes('a.html')) && marks.length && marks.every(m => m.toLowerCase() === 'a.html'),
      '검색하면 맞는 항목만 남기고 겹친 부분을 표시한다', `${found.length}건 ${marks.join(',')}`);
    await pg.fill('#q', '&');
    check(!(await pg.$$eval('#list', l => l[0].innerHTML.includes('&amp;amp;'))), '검색어에 & 가 있어도 글자가 깨지지 않는다');
    await pg.fill('#q', '');

    section('새로고침 · 뒤로가기 · 이력');
    await pg.click('.navitem[data-nav="history"]');
    check((await S()).path === '/p/quick/history' && (await pg.$$eval('#historyList tr', r => r.length)) === 1,
      '이력 화면에 방금 검사가 있다');
    await pg.reload();
    await pg.waitForFunction(() => P && HISTORY.length);
    check((await S()).view === 'history', '새로고침해도 이력 화면이 유지된다');
    await pg.goBack();
    await pg.waitForFunction(() => view === 'dash');
    check((await S()).path === '/p/quick', '뒤로가기로 이전 화면으로 돌아간다');
    check((await S()).out, '새로고침 전에 보던 결과가 대시보드에 그대로 있다');
    await pg.click('#newScanBtn');
    await pg.click('#histList button[data-i="0"]');
    check((await pg.inputValue('#url')).endsWith('/test-crawl/start.html'), '이력에서 설정을 불러오면 주소가 채워진다');

    section('서버가 검사를 모를 때 (재시작 등)');
    await pg.evaluate(() => { running = true; scanId = 'gone-scan'; lastSeq = 0; paintView(); socket.disconnect(); socket.connect(); });
    await pg.waitForFunction(() => !running, null, { timeout: 10000 }).catch(() => {});
    s = await S();
    check(!s.running && /찾을 수 없습니다/.test(s.err), '"검사 중" 에 멈추지 않고 이유를 보여준다', JSON.stringify(s));

    section('검사 중 새로고침 · 중단');
    const liveDone = () => pg.evaluate(() => ['liveOk', 'liveEr', 'liveNr', 'liveRest']
      .reduce((n, id) => n + Number(document.getElementById(id).textContent), 0));
    await pg.fill('#url', `${BASE}/test-buggy.html`);
    await pg.click('#goBtn');
    await pg.waitForFunction(() => ['liveOk', 'liveEr', 'liveNr'].reduce((n, id) => n + Number(document.getElementById(id).textContent), 0) >= 3,
      null, { timeout: 60000 });
    const before = await liveDone();
    await pg.reload();
    await pg.waitForFunction(() => running && !document.getElementById('run').hidden, null, { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    check((await S()).running && (await liveDone()) >= before, '검사 중에 새로고침해도 진행 화면으로 이어서 본다',
      `${JSON.stringify(await S())} ${before}→${await liveDone()}`);
    await pg.click('#stopBtn');
    await waitResult();
    check(/중단됨/.test(await pg.textContent('#subline')), '중단하면 그때까지의 결과를 중단됨으로 보여준다');
    const shown = (await S()).n;
    await pg.reload();
    await pg.waitForFunction(() => hasResult && !document.getElementById('out').hidden, null, { timeout: 15000 }).catch(() => {});
    check((await S()).n === shown && shown > 0, '끝난 결과는 새로고침해도 다시 보인다', `${shown} → ${(await S()).n}`);
    await pg.click('#newScanBtn');
    await pg.reload();
    await pg.waitForFunction(() => P);
    await sleep(800);
    check(!(await S()).hasResult, '결과를 닫은 뒤 새로고침하면 닫힌 채로 있다');

    section('프로젝트');
    await openMenu();
    await pg.click('#projNewBtn');
    await pg.fill('#projNewName', 'E2E 프로젝트');
    await pg.press('#projNewName', 'Enter');
    await pg.waitForFunction(() => P && !P.quick && view === 'rules');
    const pid = (await S()).pid;
    check((await S()).path === `/p/${pid}/rules`, '새 프로젝트를 만들면 그 설정 화면으로 간다');
    await pg.click('#urlAdd');
    await pg.fill('#urlRows .row:last-child .u', 'ftp://wrong');
    await pg.click('#saveRules');
    await sleep(300);
    check(/http/.test((await S()).toast), '잘못된 주소는 저장하지 않고 알린다');
    await pg.fill('#urlRows .row:last-child .lb', '시작');
    await pg.fill('#urlRows .row:last-child .u', `${BASE}/test-crawl/start.html`);
    await pg.fill('#setObserve', '1500');
    await pg.click('#saveRules');
    await pg.waitForFunction(() => P.urls.length === 1 && P.rules.observeMs === 1500);
    await pg.click('.navitem[data-nav="dash"]');
    check((await pg.inputValue('#url')).endsWith('/test-crawl/start.html') && (await pg.inputValue('#observeMs')) === '1500',
      '저장한 주소와 규칙이 새 검사 폼에 반영된다');
    await pg.click('.navitem[data-nav="history"]');
    check(await pg.isVisible('#historyBlank'), '새 프로젝트의 이력은 비어 있다 (다른 프로젝트 기록이 섞이지 않는다)');
    await pg.click('.navitem[data-nav="rules"]');
    await pg.click('#deleteProject');
    await pg.waitForFunction(() => P && P.quick);
    const list = await (await fetch(`${BASE}/api/projects`)).json();
    check((await S()).path === '/p/quick' && !list.some(x => x.id === pid), '프로젝트를 지우면 빠른 검사로 돌아간다');

    check(jsErrors.length === 0, '화면에서 JS 오류가 나지 않는다', jsErrors.join(' | '));
  } catch (e) {
    console.error(`\n  ${C.r}검증 실행 오류: ${e.stack || e.message}${C.x}\n`);
    failed++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n  ${'─'.repeat(60)}`);
  console.log(failed === 0 ? `  ${C.g}${C.b}통과 ${total}/${total}${C.x}\n` : `  ${C.r}${C.b}실패 ${failed}/${total}${C.x}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
