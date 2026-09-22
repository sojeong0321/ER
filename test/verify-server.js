/**
 * 서버 통합 검증 — 실제로 서버를 띄워 API·크롤러·내보내기·실시간 진행을 확인한다.
 *
 *   입력 검증 · 잘못된 요청 · 경로 노출 · 범위와 리디렉션 · 내보내기 · 중단 · 연결 재접속 · 공개 모드
 *
 * 데이터와 리포트는 임시 폴더에 둔다 (ER_DATA_DIR · ER_REPORTS_DIR). 실제 data/ · reports/ 는 건드리지 않는다.
 * 실행: npm test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const XLSX = require('xlsx');

const PORT = Number(process.env.TEST_PORT_SERVER) || 3990;
const PUB_PORT = PORT + 1;
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

function startServer(port, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'er-srv-'));
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), ER_DATA_DIR: path.join(tmp, 'data'), ER_REPORTS_DIR: path.join(tmp, 'reports'), ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });
  const ready = (async () => {
    for (let t0 = Date.now(); Date.now() - t0 < 20000;) {
      const ok = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.ok).catch(() => false);
      if (ok) return;
      await sleep(250);
    }
    throw new Error(`서버가 시작되지 않았습니다: ${stderr}`);
  })();
  return { proc, tmp, ready, stderr: () => stderr };
}

async function api(method, p, body, { base = BASE, raw } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function waitDone(scanId, timeoutMs = 120000) {
  for (let t0 = Date.now(); Date.now() - t0 < timeoutMs;) {
    const r = await api('GET', `/api/report/${scanId}`);
    if (r.json && r.json.status !== 'running') return r.json;
    await sleep(500);
  }
  throw new Error('검사가 끝나지 않았습니다');
}

(async () => {
  console.log(`\n  ${C.b}ER 서버 통합 검증${C.x}`);
  const srv = startServer(PORT);
  const pub = startServer(PUB_PORT, { ER_PUBLIC: '1' });
  let browser;

  try {
    await Promise.all([srv.ready, pub.ready]);

    section('잘못된 요청');
    let r = await fetch(BASE + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{깨진 JSON' })
      .then(async x => ({ status: x.status, json: await x.json().catch(() => null) }));
    check(r.status === 400 && r.json?.error, '깨진 JSON 은 400 과 읽을 수 있는 오류로 답한다', JSON.stringify(r));
    r = await api('POST', '/api/scan', { url: 'ftp://a.com' });
    check(r.status === 400 && /http/.test(r.json?.error), 'http(s) 가 아닌 주소는 거부한다');
    r = await api('POST', '/api/scan', { url: `${BASE}/`, projectId: 'nope' });
    check(r.status === 400 && /프로젝트/.test(r.json?.error), '없는 프로젝트는 거부한다');
    r = await api('PUT', '/api/projects/quick', { auth: { url: 'javascript:alert(1)' } });
    check(r.status === 400 && r.json?.error, '잘못된 로그인 주소 저장은 400');
    r = await api('PUT', '/api/projects/quick', { rules: { observeMs: -5 } });
    check(r.status === 400, '범위 밖 규칙 저장은 400');
    r = await api('POST', '/api/projects', { name: '   ' });
    check(r.status === 400, '빈 이름으로는 프로젝트를 만들지 않는다');
    r = await api('GET', '/api/report/nope');
    check(r.status === 404 && r.json?.error, '없는 검사 결과는 404');
    r = await api('GET', '/api/report/nope/export?format=xlsx');
    check(r.status === 404, '없는 검사는 내보내지 않는다');

    section('검사 — 범위·리디렉션·값 보정');
    r = await api('POST', '/api/scan', {
      url: `${BASE}/test-crawl/start.html`, projectId: 'quick', scope: 'path',
      observeMs: 'abc', maxPages: 99999, excludeRules: ['삭제', 3, '', null, '삭제'],
    });
    check(r.status === 200 && r.json?.scanId, '검사를 시작한다', r.text);
    const scanId = r.json.scanId;
    const rep = await waitDone(scanId);
    const pages = [...new Set(rep.results.map(x => x.page))];
    check(rep.status === 'done', '검사가 끝난다', rep.message);
    check(pages.some(p => p.endsWith('/test-crawl/start.html')) && pages.some(p => p.endsWith('/test-crawl/a.html')),
      '범위 안의 페이지를 순회한다', pages.join(', '));
    check(!pages.some(p => p.includes('/test-crawlx/')), '이름만 비슷한 형제 폴더(/test-crawlx)는 범위 밖 — 링크로도, 넘겨져서도', pages.join(', '));
    check(!pages.some(p => p.includes('localhost')), '다른 사이트로 넘겨진 페이지는 검사하지 않는다', pages.join(', '));
    check(pages.length === 2, '같은 페이지를 두 번 검사하지 않는다 (해시만 다른 링크 포함)', pages.join(', '));
    const dead = rep.results.find(x => x.sel === 'button#dead');
    check(dead?.status === 'NO-RESPONSE' && dead.screenshot, '반응 없는 버튼을 무감으로 잡고 화면을 남긴다', JSON.stringify(dead));

    const hist = await api('GET', '/api/history?projectId=quick');
    const entry = hist.json?.find(h => h.scanId === scanId);
    check(entry?.settings.observeMs === 2000 && entry.settings.maxPages === 1000,
      '숫자가 아닌 관찰 시간은 기본값, 너무 큰 페이지 수는 상한으로 맞춘다', JSON.stringify(entry?.settings));
    check(JSON.stringify(entry?.settings.excludeRules) === '["삭제","3"]', '제외 단어를 문자열로 정리하고 중복·빈 값을 뺀다',
      JSON.stringify(entry?.settings.excludeRules));

    section('리포트·내보내기');
    r = await api('GET', '/reports/history.json');
    check(r.status === 404, '검사 이력 파일(history.json)은 밖으로 내보내지 않는다', r.status);
    r = await api('GET', `/reports/${scanId}/smoke-report.html`);
    check(r.status === 200 && r.text.includes('결함'), '저장된 HTML 리포트를 연다');
    r = await api('GET', `/reports/${scanId}/shots/${encodeURIComponent(dead.screenshot)}`);
    check(r.status === 200, '스크린샷 파일을 연다');
    r = await api('GET', `/reports/${scanId}/없는파일.html`);
    check(r.status === 404 && /리포트 파일이 없습니다/.test(r.text), '없는 리포트는 안내 화면으로 답한다');
    r = await api('GET', `/api/report/${scanId}/export?format=html&filter=DEFECT`);
    check(r.status === 200 && !/attachment/.test(r.headers.get('content-disposition') || '') &&
      r.text.includes(`/reports/${scanId}/shots/`), 'HTML 내보내기는 새 탭에서 열리고 스크린샷이 절대 경로다');
    const [x1, x2] = await Promise.all([1, 2].map(() => fetch(`${BASE}/api/report/${scanId}/export?format=xlsx&filter=ALL`)
      .then(async res => ({ status: res.status, buf: Buffer.from(await res.arrayBuffer()), cd: res.headers.get('content-disposition') }))));
    const parse = b => { try { return XLSX.read(b, { type: 'buffer' }).SheetNames.join(); } catch { return ''; } };
    check(x1.status === 200 && x2.status === 200 && parse(x1.buf) === '요약,상세' && parse(x2.buf) === '요약,상세' &&
      /attachment/.test(x1.cd), '엑셀을 동시에 두 번 받아도 둘 다 온전하다');
    r = await api('GET', `/api/report/${scanId}/export?format=md&filter=NO-RESPONSE`);
    check(r.status === 200 && r.text.includes('반응 없는 버튼') && !r.text.includes('| 정상 |'), 'Markdown 을 탭 기준으로 내보낸다');
    r = await api('GET', `/api/report/${scanId}/export?format=pdf`);
    check(r.status === 400, '지원하지 않는 형식은 400');

    section('실시간 진행 — 재접속');
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`${BASE}/test-crawl/b.html`);
    await page.addScriptTag({ url: '/socket.io/socket.io.js' });
    const replay = await page.evaluate(id => new Promise(resolve => {
      const s = window.io();
      const got = [];
      ['log', 'page', 'element', 'pageResult', 'done', 'scanError'].forEach(ev => s.on(ev, d => got.push({ ev, seq: d.seq, scanId: d.scanId })));
      s.emit('join', id, 0);
      setTimeout(() => {
        const last = Math.max(...got.map(g => g.seq));
        const s2 = window.io({ forceNew: true });
        const again = [];
        ['log', 'page', 'element', 'pageResult', 'done'].forEach(ev => s2.on(ev, d => again.push(d.seq)));
        s2.emit('join', id, last - 3);
        const s3 = window.io({ forceNew: true });
        let missing = null;
        s3.on('scanError', d => { missing = d; });
        s3.emit('join', 'no-such-scan', 0);
        setTimeout(() => resolve({ got, last, again, missing }), 800);
      }, 800);
    }), scanId);
    const seqs = replay.got.map(g => g.seq);
    check(replay.got.length > 5 && replay.got.every(g => g.scanId === scanId) && seqs.every((v, i) => !i || v > seqs[i - 1]),
      '지나간 이벤트를 순번 순서대로 다시 받는다', JSON.stringify(seqs.slice(0, 10)));
    check(replay.got.some(g => g.ev === 'done'), '끝난 검사에 들어와도 완료 이벤트를 받는다');
    check(JSON.stringify(replay.again) === JSON.stringify([replay.last - 2, replay.last - 1, replay.last]),
      '다시 붙을 때는 받은 순번 다음부터만 받는다', JSON.stringify(replay.again));
    check(replay.missing && /찾을 수 없습니다/.test(replay.missing.msg), '서버가 모르는 검사면 멈춰 있지 않게 오류로 알린다');

    section('중단');
    r = await api('POST', '/api/scan', { url: `${BASE}/test-buggy.html`, projectId: 'quick', scope: 'page' });
    const longId = r.json.scanId;
    await sleep(9000);
    await api('POST', `/api/scan/${longId}/stop`);
    const stopped = await waitDone(longId, 60000);
    check(stopped.status === 'done' && stopped.meta?.stopped, '중단하면 완료 상태로 끝나고 중단 표시가 남는다', JSON.stringify(stopped.meta));
    check(stopped.results.length > 0 && stopped.results.length < 25, '중단 전까지 검사한 결과는 남긴다', stopped.results.length);
    const h2 = (await api('GET', '/api/history?projectId=quick')).json.find(h => h.scanId === longId);
    check(h2?.stopped === true, '이력에도 중단된 검사로 남는다');
    r = await api('POST', '/api/scan/no-such/stop');
    check(r.status === 404, '없는 검사는 중단할 수 없다');

    section('공개 모드 (ER_PUBLIC=1)');
    const PB = `http://127.0.0.1:${PUB_PORT}`;
    r = await api('POST', '/api/scan', { url: `${PB}/test-target.html`, projectId: 'quick' }, { base: PB });
    check(r.status === 400 && /내부 주소/.test(r.json?.error), '서버 안쪽 주소는 검사하지 않는다', r.text);
    r = await api('POST', '/api/scan', { url: 'http://169.254.169.254/latest/meta-data/', projectId: 'quick' }, { base: PB });
    check(r.status === 400, '클라우드 메타데이터 주소를 막는다');
    r = await api('GET', '/api/info', undefined, { base: PB });
    check(r.json?.public === true && !r.json.addresses.length, '내부 접속 주소를 알리지 않는다');
  } catch (e) {
    console.error(`\n  ${C.r}검증 실행 오류: ${e.stack || e.message}${C.x}\n`);
    failed++;
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const s of [srv, pub]) {
      s.proc.kill();
      fs.rmSync(s.tmp, { recursive: true, force: true });
    }
  }

  const errs = srv.stderr().trim();
  if (errs) console.log(`\n  ${C.d}서버 오류 출력:\n${errs.slice(0, 1500)}${C.x}`);
  console.log(`\n  ${'─'.repeat(60)}`);
  console.log(failed === 0 ? `  ${C.g}${C.b}통과 ${total}/${total}${C.x}\n` : `  ${C.r}${C.b}실패 ${failed}/${total}${C.x}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
