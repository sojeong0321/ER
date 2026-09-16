/**
 * ER — 자동 스모크 테스트 웹 서버
 *
 * 로컬(또는 사내 서버)에서 실행하고, 같은 네트워크의 동료는 이 PC의 주소로 접속한다.
 * 스캔 엔진이 이 PC에서 돌기 때문에 이 PC가 닿는 주소(사내망·VPN·localhost)는 모두 검사할 수 있다.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { chromium } = require('playwright');
const login_ = require('./src/login');
const { doLogin, readSession, saveSession, clearSession } = login_;
const totp = require('./src/totp');
const { crawl } = require('./src/crawler');
const { saveHtml, saveExcel } = require('./src/reporter');
const cfg = require('./config.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/reports', express.static(path.join(__dirname, 'reports')));

/** scanId → { status, events[], results, meta, stop } */
const scans = new Map();
const MAX_SCANS = 20;

/**
 * 이벤트를 저장하면서 내보낸다.
 * 클라이언트가 소켓 룸에 들어오기 전에 발생한 이벤트도 join 시점에 다시 받아볼 수 있어야
 * 진행 로그가 유실되지 않는다. (이전 버전은 400ms 지연으로 타이밍에 기대고 있었다)
 */
function emitter(scanId) {
  const scan = scans.get(scanId);
  return (event, data) => {
    scan.events.push({ event, data });
    if (scan.events.length > 2000) scan.events.splice(0, 1000);
    io.to(scanId).emit(event, data);
  };
}

app.post('/api/scan', (req, res) => {
  const { url, scope, login, excludeRules, observeMs, maxPages, authMode } = req.body || {};
  if (!url || !/^https?:\/\//i.test(String(url))) {
    return res.status(400).json({ error: 'http:// 또는 https:// 로 시작하는 URL을 입력하세요.' });
  }

  // 오래된 스캔부터 정리
  while (scans.size >= MAX_SCANS) scans.delete(scans.keys().next().value);

  const scanId = crypto.randomUUID().slice(0, 8);
  scans.set(scanId, { status: 'running', events: [], stop: false, startedAt: Date.now() });
  res.json({ scanId });

  runScan(scanId, {
    url: String(url).trim(),
    scope: scope || cfg.scope || 'path',
    login,
    authMode: authMode || 'none',
    excludeRules,
    observeMs: Number(observeMs) || cfg.observeMs || 2000,
    maxPages: Number(maxPages) || cfg.maxPages || 50,
  });
});

app.post('/api/scan/:scanId/stop', (req, res) => {
  const scan = scans.get(req.params.scanId);
  if (!scan) return res.status(404).json({ error: '스캔을 찾을 수 없습니다.' });
  scan.stop = true;
  res.json({ ok: true });
});

app.get('/api/report/:scanId', (req, res) => {
  const scan = scans.get(req.params.scanId);
  if (!scan) return res.status(404).json({ error: '스캔 결과가 없습니다.' });
  res.json({ status: scan.status, results: scan.results, meta: scan.meta, message: scan.message });
});

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

/** 같은 사내망의 동료에게 알려줄 접속 주소 — 화면에 그대로 띄운다 */
app.get('/api/info', (req, res) => {
  const port = server.address()?.port || PORT;
  res.json({
    port,
    addresses: lanAddresses().map(ip => `http://${ip}:${port}`),
    hostname: `http://${os.hostname().replace(/\.local$/, '')}.local:${port}`,
  });
});

/** 저장된 로그인 세션이 있는지 알려준다 */
app.get('/api/session', (req, res) => {
  const s = readSession();
  res.json({
    ...(s ? { exists: true, savedAt: s.savedAt, url: s.url } : { exists: false }),
    pending: !!loginSession,
  });
});

/**
 * 로그인용 브라우저 창을 띄운다.
 * 사람이 직접 로그인해야 통과되는 인증(OTP·SSO)이 있어도 이 경로로 세션을 확보할 수 있다.
 * 창은 이 서버가 실행 중인 PC 화면에 뜬다.
 */
let loginSession = null;   // { browser, context, page, url }

app.post('/api/session/open', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(String(url))) {
    return res.status(400).json({ error: 'http:// 또는 https:// 로 시작하는 로그인 주소를 입력하세요.' });
  }
  if (loginSession) {
    try { await loginSession.browser.close(); } catch {}
    loginSession = null;
  }
  try {
    const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
    const context = await browser.newContext({
      ignoreHTTPSErrors: cfg.ignoreHTTPSErrors !== false,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(String(url).trim(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    loginSession = { browser, context, page, url: String(url).trim() };

    // 사용자가 창을 그냥 닫으면 상태를 정리한다
    browser.on('disconnected', () => { loginSession = null; });

    res.json({ ok: true });
  } catch (e) {
    loginSession = null;
    res.status(500).json({ error: `로그인 창을 열지 못했습니다: ${String(e.message).split('\n')[0]}` });
  }
});

/** 로그인이 끝난 상태를 저장한다 */
app.post('/api/session/save', async (req, res) => {
  if (!loginSession) return res.status(400).json({ error: '열려 있는 로그인 창이 없습니다. 먼저 로그인 창을 여세요.' });
  try {
    const state = await loginSession.context.storageState();
    const landedOn = loginSession.page.url();
    const info = saveSession(state, landedOn);
    await loginSession.browser.close().catch(() => {});
    loginSession = null;
    res.json({ ok: true, cookies: state.cookies.length, landedOn, savedAt: info.savedAt });
  } catch (e) {
    res.status(500).json({ error: `저장하지 못했습니다: ${String(e.message).split('\n')[0]}` });
  }
});

/** 로그인 창을 닫는다 (저장하지 않음) */
app.post('/api/session/cancel', async (req, res) => {
  if (loginSession) {
    await loginSession.browser.close().catch(() => {});
    loginSession = null;
  }
  res.json({ ok: true });
});

/** 저장된 로그인을 지운다 */
app.delete('/api/session', (req, res) => {
  clearSession();
  res.json({ ok: true });
});

/* ── 계정 정보 ── */

app.get('/api/credentials', (req, res) => res.json(login_.describeCredentials()));

app.post('/api/credentials', (req, res) => {
  const { url, username, password, otp } = req.body || {};
  if (otp) {
    const kind = totp.describeInput(otp);
    if (kind.kind === 'invalid') return res.status(400).json({ error: kind.error });
  }
  const saved = login_.saveCredentials({ url, username, password, otp });
  res.json({ ok: true, savedAt: saved.savedAt });
});

app.delete('/api/credentials', (req, res) => {
  login_.clearCredentials();
  res.json({ ok: true });
});

/** OTP 입력값을 확인한다 — 실제로 어떤 값이 입력될지 미리 보여준다 */
app.post('/api/otp/check', (req, res) => {
  const value = req.body?.otp || login_.readCredentials()?.otp;
  if (!value) return res.status(400).json({ error: 'OTP 값이 비어 있습니다.' });
  const kind = totp.describeInput(value);
  if (kind.kind === 'invalid') return res.status(400).json({ error: kind.error });
  if (kind.kind === 'fixed') return res.json({ ok: true, kind: 'fixed', code: String(value).trim() });
  res.json({ ok: true, kind: 'generated', code: totp.generate(value), secondsLeft: totp.secondsLeft(value) });
});

/** 로그인 자동화 검증용 화면 — 실제 사내 시스템과 같은 조건(이름 없는 입력칸·form 없음·OTP) */
app.get('/test-login.html', (req, res) => res.sendFile(path.join(__dirname, 'test-login.html')));

const TEST_ACCOUNT = { id: 'tester', pw: 'test1234', secret: 'JBSWY3DPEHPK3PXP', fixedCode: '123123' };
app.post('/api/_test/login', (req, res) => {
  const { id, pw, otp } = req.body || {};
  if (id !== TEST_ACCOUNT.id || pw !== TEST_ACCOUNT.pw) {
    return res.json({ ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
  // 시계 오차를 감안해 앞뒤 한 칸까지 인정한다 (표준 구현과 동일)
  const now = Date.now();
  // 개발 서버가 흔히 그렇듯 고정 코드도 통과시킨다
  const valid = [TEST_ACCOUNT.fixedCode, ...[-30000, 0, 30000].map(d => totp.generate(TEST_ACCOUNT.secret, now + d))];
  if (!valid.includes(String(otp))) {
    return res.json({ ok: false, error: 'OTP 코드가 올바르지 않습니다.' });
  }
  res.cookie?.('er_test_session', '1');
  res.setHeader('Set-Cookie', 'er_test_session=1; Path=/; SameSite=Lax');
  res.json({ ok: true });
});

/** 회귀 테스트용 대상 페이지 */
app.get('/test-target.html', (req, res) => res.sendFile(path.join(__dirname, 'test-target.html')));

/** 회귀 테스트(test-target.html)에서 서버 에러 판정을 검증하기 위한 고정 500 응답 */
app.get('/api/_test/500', (req, res) => res.status(500).json({ error: 'intentional test error' }));
app.get('/api/_test/ok', (req, res) => res.json({ ok: true }));

async function runScan(scanId, options) {
  const scan = scans.get(scanId);
  const emit = emitter(scanId);
  const { url, scope, login, authMode, excludeRules, observeMs, maxPages } = options;
  let browser = null;

  try {
    emit('log', { msg: '브라우저 시작 중…' });
    try {
      browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
    } catch (e) {
      throw new Error(browserHint(e));
    }

    let storageState;
    if (authMode === 'session') {
      const saved = readSession();
      if (!saved) throw new Error('저장된 로그인이 없습니다. 먼저 로그인 창을 열어 로그인해 주세요.');
      storageState = saved.state;
      emit('log', { msg: `저장된 로그인으로 검사합니다 (${new Date(saved.savedAt).toLocaleString('ko-KR')} 저장).` });
    }

    const context = await browser.newContext({
      ignoreHTTPSErrors: cfg.ignoreHTTPSErrors !== false,
      acceptDownloads: false,
      viewport: { width: 1440, height: 900 },
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();

    if (authMode === 'credentials') {
      // 화면에서 받은 값이 없으면 이 PC 에 저장된 계정 정보를 쓴다
      const saved = login_.readCredentials() || {};
      const merged = {
        ...cfg.login,
        url: login?.url || saved.url,
        username: login?.username || saved.username,
        password: login?.password || saved.password,
        otp: login?.otp || saved.otp,
        onLog: msg => emit('log', { msg }),
      };
      if (!merged.url) throw new Error('로그인 주소가 비어 있습니다.');
      if (!merged.username || !merged.password) throw new Error('아이디와 비밀번호를 입력하세요.');

      emit('log', { msg: '로그인 중…' });
      await doLogin(page, merged);
      emit('log', { msg: '로그인에 성공했습니다.' });
    }

    emit('log', { msg: `${url} 접속 중…` });
    const t0 = Date.now();

    const results = await crawl(browser, url, scope, ev => {
      if (ev.type === 'page') emit('page', { url: ev.url, visited: ev.visited, queued: ev.queued });
      if (ev.type === 'element') emit('element', { url: ev.url, index: ev.index, total: ev.total, status: ev.result.status });
      if (ev.type === 'done') emit('pageResult', { url: ev.url, count: ev.count });
      if (ev.type === 'pageError') emit('log', { msg: `접근 실패: ${ev.url} — ${ev.msg}` });
      if (ev.type === 'limit') emit('log', { msg: `최대 페이지 수(${ev.max}) 도달 — ${ev.skipped}개 페이지를 건너뜁니다.` });
      if (ev.type === 'stopped') emit('log', { msg: '사용자 요청으로 중단했습니다.' });
    }, {
      observeMs,
      excludeRules,
      maxPages,
      screenshotDir: ensureDir(path.join(__dirname, 'reports', scanId, 'shots')),
      shouldStop: () => scan.stop,
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    await browser.close().catch(() => {});
    browser = null;

    const meta = {
      url, scope, elapsed,
      scannedAt: new Date().toLocaleString('ko-KR'),
      stopped: scan.stop,
      scanId,
    };

    const outputDir = path.join(__dirname, 'reports', scanId);
    saveHtml(results, meta, outputDir);
    saveExcel(results, meta, outputDir);

    Object.assign(scan, { status: 'done', results, meta });
    emit('done', { results, meta, scanId });

  } catch (e) {
    const msg = String(e?.message || e);
    console.error('스캔 오류:', msg);
    Object.assign(scan, { status: 'error', message: msg });
    emit('scanError', { msg });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** Playwright 브라우저 미설치처럼 흔한 실패는 해결 방법까지 알려준다 */
function browserHint(e) {
  const m = String(e?.message || e);
  if (/Executable doesn't exist|browserType\.launch.*ENOENT|Please run the following command/i.test(m)) {
    return '브라우저(Chromium)가 설치되어 있지 않습니다. 터미널에서 "npx playwright install chromium" 을 실행한 뒤 다시 시도하세요.';
  }
  if (/Target page, context or browser has been closed/i.test(m)) {
    return '브라우저가 예기치 않게 종료됐습니다. 메모리가 부족한 환경일 수 있습니다.';
  }
  return `브라우저를 시작하지 못했습니다: ${m.split('\n')[0]}`;
}

function ensureDir(p) {
  require('fs').mkdirSync(p, { recursive: true });
  return p;
}

io.on('connection', socket => {
  socket.on('join', scanId => {
    socket.join(scanId);
    // 입장 전에 쌓인 이벤트를 재생해 로그 유실을 막는다
    const scan = scans.get(scanId);
    if (scan) scan.events.forEach(({ event, data }) => socket.emit(event, data));
  });
});

/** 같은 네트워크의 동료가 접속할 수 있는 주소들 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';   // 0.0.0.0 이어야 다른 PC에서 접속된다
server.listen(PORT, HOST, () => {
  const hostname = os.hostname().replace(/\.local$/, '');
  console.log('');
  console.log('  ER — 자동 스모크 테스트 서버가 실행 중입니다.');
  console.log('');
  console.log(`    내 PC에서      →  http://localhost:${PORT}`);
  lanAddresses().forEach(ip => console.log(`    같은 사내망에서 →  http://${ip}:${PORT}`));
  console.log(`    이름으로       →  http://${hostname}.local:${PORT}   (윈도우에서는 안 될 수 있음)`);
  console.log('');
  console.log('  종료하려면 Ctrl + C');
  console.log('');
});
