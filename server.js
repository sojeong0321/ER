/**
 * ER — 자동 스모크 테스트 웹 서버
 *
 * 로컬(또는 사내 서버)에서 실행하고, 같은 네트워크의 동료는 이 PC의 주소로 접속한다.
 * 스캔 엔진이 이 PC에서 돌기 때문에 이 PC가 닿는 주소(사내망·VPN·localhost)는 모두 검사할 수 있다.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { chromium } = require('playwright');
const login_ = require('./src/login');
const { doLogin, readSession, saveSession, clearSession } = login_;
const totp = require('./src/totp');
const { crawl } = require('./src/crawler');
const { saveHtml, saveExcel, saveMarkdown, buildHtml, buildMarkdown } = require('./src/reporter');
const baseCfg = require('./config.json');

/**
 * 설정은 두 겹이다.
 *  - config.json        저장소에 들어가는 기본값
 *  - config.local.json  이 PC 에서 바꾼 값 (git 에 올라가지 않는다)
 * 화면에서 저장하면 아래쪽에만 쓰고, 읽을 때 위에 덮어 쓴다.
 */
const LOCAL_CFG = path.join(__dirname, 'config.local.json');

function readLocalCfg() {
  try { return JSON.parse(fs.readFileSync(LOCAL_CFG, 'utf8')); } catch { return {}; }
}
function currentCfg() {
  const local = readLocalCfg();
  return { ...baseCfg, ...local, login: { ...baseCfg.login, ...(local.login || {}) } };
}
let cfg = currentCfg();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/reports', express.static(path.join(__dirname, 'reports')));

/**
 * 리포트 파일이 없을 때 안내한다.
 * 서버를 다시 시작했거나 오래된 기록이 정리되면 화면에는 링크가 남아 있어도 파일은 없다.
 * 기본 404 는 "Cannot GET ..." 만 보여줘 무슨 상황인지 알 수 없다.
 */
app.get('/reports/*', (req, res) => {
  const wantsFile = /\.(html|xlsx|md|png)$/i.test(req.path);
  if (!wantsFile) return res.status(404).json({ error: '없는 경로입니다.' });

  res.status(404).type('html').send(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>리포트를 찾을 수 없습니다</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;
    max-width:520px;margin:90px auto;padding:0 24px;color:#1f1f28;line-height:1.7}
  h1{font-size:20px;margin-bottom:10px}
  p{color:#5f5f6d;font-size:14.5px}
  ul{color:#5f5f6d;font-size:14px;margin:14px 0 0 18px}
  a{display:inline-block;margin-top:24px;background:#7c5cff;color:#fff;text-decoration:none;
    padding:11px 20px;border-radius:9px;font-size:14px;font-weight:600}
</style></head>
<body>
  <h1>리포트 파일이 없습니다</h1>
  <p>검사 결과 화면에는 링크가 남아 있지만, 서버에 파일이 없습니다. 보통 이런 경우입니다.</p>
  <ul>
    <li>서버를 다시 시작한 뒤라 이전 검사의 파일이 정리됐다</li>
    <li>1년이 지나 오래된 기록과 함께 지워졌다</li>
    <li>리포트 폴더를 직접 비웠다</li>
  </ul>
  <p style="margin-top:16px">같은 주소를 <b>다시 검사</b>하면 리포트가 새로 만들어집니다.</p>
  <a href="/">검사 화면으로</a>
</body></html>`);
});

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
  const { url, scope, login, excludeRules, observeMs, maxPages, authMode, clickNewTab, clickExternal } = req.body || {};
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
    clickNewTab: !!clickNewTab,
    clickExternal: !!clickExternal,
  });
});

app.post('/api/scan/:scanId/stop', (req, res) => {
  const scan = scans.get(req.params.scanId);
  if (!scan) return res.status(404).json({ error: '검사를 찾을 수 없습니다.' });
  scan.stop = true;
  res.json({ ok: true });

  // 페이지 이동을 기다리는 중이면 깃발만으로는 즉시 멈추지 않는다.
  // 잠시 기다려 보고도 끝나지 않으면 브라우저를 닫아 대기를 끊는다.
  // 그때까지 모은 결과는 그대로 살아남는다.
  setTimeout(() => {
    if (scan.status === 'running' && scan.browser) {
      scan.browser.close().catch(() => {});
    }
  }, 2500);
});

app.get('/api/report/:scanId', (req, res) => {
  const scan = scans.get(req.params.scanId);
  if (!scan) return res.status(404).json({ error: '스캔 결과가 없습니다.' });
  res.json({ status: scan.status, results: scan.results, meta: scan.meta, message: scan.message });
});

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

/* ── 기본 검사 규칙 ── */

/** 화면에서 바꾼 기본값은 이 PC 에 저장되어, 사내망으로 접속한 동료에게도 같이 적용된다 */
app.get('/api/settings', (req, res) => {
  const c = currentCfg();
  res.json({
    observeMs: c.observeMs,
    maxPages: c.maxPages,
    scope: c.scope,
    excludeRules: c.excludeRules || [],
    clickNewTab: !!c.clickNewTab,
    clickExternal: !!c.clickExternal,
    ignoreHTTPSErrors: c.ignoreHTTPSErrors !== false,
    changed: Object.keys(readLocalCfg()).length > 0,
  });
});

app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const next = {};

  const num = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  const observeMs = num(b.observeMs, 300, 60000);
  const maxPages = num(b.maxPages, 1, 1000);
  if (observeMs === null || maxPages === null) {
    return res.status(400).json({ error: '관찰 시간은 300~60000ms, 최대 페이지는 1~1000 사이여야 합니다.' });
  }
  next.observeMs = observeMs;
  next.maxPages = maxPages;
  if (['page', 'path', 'domain'].includes(b.scope)) next.scope = b.scope;
  if (Array.isArray(b.excludeRules)) {
    next.excludeRules = [...new Set(b.excludeRules.map(x => String(x).trim()).filter(Boolean))].slice(0, 100);
  }
  next.clickNewTab = !!b.clickNewTab;
  next.clickExternal = !!b.clickExternal;
  next.ignoreHTTPSErrors = b.ignoreHTTPSErrors !== false;

  fs.writeFileSync(LOCAL_CFG, JSON.stringify(next, null, 2), 'utf8');
  cfg = currentCfg();
  res.json({ ok: true });
});

/** 기본값으로 되돌린다 */
app.delete('/api/settings', (req, res) => {
  try { fs.unlinkSync(LOCAL_CFG); } catch {}
  cfg = currentCfg();
  res.json({ ok: true });
});

/**
 * 화면에 창을 띄울 수 있는 환경인가.
 * 서버(특히 컨테이너)에는 화면이 없어 "직접 로그인" 창을 띄워도 아무도 볼 수 없다.
 * 그 경우 그 방법을 권하지 않아야 한다.
 */
function canOpenWindow() {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Runner 상태 — 어떤 브라우저로, 어떤 설정으로 도는지 화면에 밝힌다 */
let browserVersion = null;
app.get('/api/runner', async (req, res) => {
  if (!browserVersion) {
    try {
      const b = await chromium.launch({ args: ['--no-sandbox'] });
      browserVersion = b.version();
      await b.close();
    } catch { browserVersion = '사용 불가'; }
  }
  const busy = [...scans.values()].some(s => s.status === 'running');
  res.json({
    browser: `chromium ${browserVersion}`,
    version: require('./package.json').version,
    observeMs: cfg.observeMs,
    maxPages: cfg.maxPages,
    viewport: '1440×900',
    state: busy ? 'busy' : 'idle',
    peers: io.engine.clientsCount,
    host: os.hostname().replace(/\.local$/, ''),
    canOpenWindow: canOpenWindow(),
  });
});

/** 같은 사내망에서 접속할 수 있는 주소 — 화면에 그대로 띄운다 */
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
  if (!canOpenWindow()) {
    return res.status(400).json({
      error: '이 서버에는 화면이 없어 로그인 창을 띄울 수 없습니다. ' +
             '아이디·비밀번호 방식을 쓰거나, 화면이 있는 PC에서 ER 을 실행해 로그인 상태를 만든 뒤 ' +
             'auth.local.json 을 서버로 옮기세요.',
    });
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

/* ── 검사 이력 ── */

const HISTORY_FILE = path.join(__dirname, 'reports', 'history.json');
const HISTORY_KEEP_DAYS = 365;   // 1년 지난 기록은 정리한다

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

/** 같은 주소를 다시 검사할 수 있도록 설정까지 함께 남긴다 */
function recordHistory(scanId, meta, results, options) {
  const c = { ERROR: 0, 'NO-RESPONSE': 0, PASS: 0, EXCLUDED: 0, UNCLICKABLE: 0 };
  results.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });

  const entry = {
    scanId,
    url: meta.url,
    scope: meta.scope,
    scannedAt: meta.scannedAt,
    at: Date.now(),
    elapsed: meta.elapsed,
    stopped: !!meta.stopped,
    total: results.length,
    defects: c.ERROR + c['NO-RESPONSE'],
    counts: c,
    // 재검사용 설정
    settings: {
      scope: options.scope,
      observeMs: options.observeMs,
      maxPages: options.maxPages,
      excludeRules: options.excludeRules,
      authMode: options.authMode,
      clickNewTab: options.clickNewTab,
      clickExternal: options.clickExternal,
    },
  };

  const list = readHistory();
  list.unshift(entry);

  // 1년이 지난 기록만 정리한다. 리포트 폴더도 함께 지워 디스크가 계속 불어나지 않게 한다.
  const cutoff = Date.now() - HISTORY_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const kept = [], expired = [];
  for (const h of list) ((h.at || 0) >= cutoff ? kept : expired).push(h);
  for (const gone of expired) {
    fs.rm(path.join(__dirname, 'reports', String(gone.scanId)), { recursive: true, force: true }, () => {});
  }

  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(kept, null, 2), 'utf8');
}

app.get('/api/history', (req, res) => {
  const url = req.query.url;
  const list = readHistory();
  res.json(url ? list.filter(h => h.url === url) : list);
});



/* ── 내보내기 ── */

const FILTER_LABEL = {
  ALL: '전체', ERROR: '에러만', 'NO-RESPONSE': '무감만',
  DEFECT: '결함만(에러·무감)', PASS: '정상만', EXCLUDED: '검사 제외만',
};

function applyFilter(results, filter) {
  if (!filter || filter === 'ALL') return results;
  if (filter === 'DEFECT') return results.filter(r => r.status === 'ERROR' || r.status === 'NO-RESPONSE');
  if (filter === 'EXCLUDED') return results.filter(r => r.status === 'EXCLUDED' || r.status === 'UNCLICKABLE');
  return results.filter(r => r.status === filter);
}

/**
 * 현재 보고 있는 탭만 골라 내보낸다.
 * 예를 들어 무감 탭에서 내보내면 무감 항목만 담긴 파일이 나온다.
 */
app.get('/api/report/:scanId/export', (req, res) => {
  const scan = scans.get(req.params.scanId);
  if (!scan || scan.status !== 'done') return res.status(404).json({ error: '검사 결과가 없습니다.' });

  const format = String(req.query.format || 'md').toLowerCase();
  const filter = String(req.query.filter || 'ALL').toUpperCase();
  const picked = applyFilter(scan.results, filter);
  const meta = { ...scan.meta, filterLabel: FILTER_LABEL[filter] || '전체' };
  const suffix = filter === 'ALL' ? '' : `-${filter.toLowerCase().replace(/[^a-z]/g, '')}`;
  const base = `smoke-report${suffix}`;

  const send = (body, type, ext) => {
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition',
      `attachment; filename="${base}.${ext}"; filename*=UTF-8''${encodeURIComponent(base + '.' + ext)}`);
    res.send(body);
  };

  if (format === 'md') return send(buildMarkdown(picked, meta), 'text/markdown; charset=utf-8', 'md');
  if (format === 'html') return send(buildHtml(picked, meta), 'text/html; charset=utf-8', 'html');
  if (format === 'xlsx') {
    const dir = path.join(__dirname, 'reports', req.params.scanId, 'export');
    const file = saveExcel(picked, meta, dir);
    return res.download(file, `${base}.xlsx`);
  }
  res.status(400).json({ error: '지원하지 않는 형식입니다.' });
});

async function runScan(scanId, options) {
  const scan = scans.get(scanId);
  const emit = emitter(scanId);
  const { url, scope, login, authMode, excludeRules, observeMs, maxPages, clickNewTab, clickExternal } = options;
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

    scan.browser = browser;

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
      if (ev.type === 'element') emit('element', {
        url: ev.url, index: ev.index, total: ev.total,
        status: ev.result.status, label: ev.result.label, sel: ev.result.sel, reason: ev.result.reason,
      });
      if (ev.type === 'done') emit('pageResult', { url: ev.url, count: ev.count });
      if (ev.type === 'pageError') emit('log', { msg: `접근 실패: ${ev.url} — ${ev.msg}` });
      if (ev.type === 'limit') emit('log', { msg: `최대 페이지 수(${ev.max}) 도달 — ${ev.skipped}개 페이지를 건너뜁니다.` });
      if (ev.type === 'stopped') emit('log', { msg: '사용자 요청으로 중단했습니다.' });
      if (ev.type === 'loggedOut') emit('log', {
        msg: '로그인 화면이 보입니다 — 로그인되지 않은 상태로 검사 중입니다. ' +
             '이대로 두면 로그인 화면의 요소만 검사됩니다. ' +
             '로그인 설정을 켰는지, 세션이 만료되지 않았는지 확인하세요.',
      });
    }, {
      observeMs,
      excludeRules,
      maxPages,
      clickNewTab,
      clickExternal,
      screenshotDir: ensureDir(path.join(__dirname, 'reports', scanId, 'shots')),
      shouldStop: () => scan.stop,
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    await browser.close().catch(() => {});
    browser = null;
    scan.browser = null;

    const meta = {
      url, scope, elapsed,
      scannedAt: new Date().toLocaleString('ko-KR'),
      stopped: scan.stop,
      scanId,
    };

    const outputDir = path.join(__dirname, 'reports', scanId);
    saveHtml(results, meta, outputDir);
    saveExcel(results, meta, outputDir);
    saveMarkdown(results, meta, outputDir);
    recordHistory(scanId, meta, results, options);

    Object.assign(scan, { status: 'done', results, meta });
    emit('done', { results, meta, scanId });

  } catch (e) {
    const msg = String(e?.message || e);
    if (scan.stop) {
      // 중단 요청으로 브라우저를 닫아 생긴 예외다. 오류로 알릴 일이 아니다.
      emit('log', { msg: '중단했습니다.' });
      Object.assign(scan, { status: 'done', results: scan.results || [], meta: scan.meta || { url, scope, elapsed: '0', scannedAt: new Date().toLocaleString('ko-KR'), stopped: true, scanId } });
      emit('done', { results: scan.results || [], meta: scan.meta, scanId });
    } else {
      console.error('검사 오류:', msg);
      Object.assign(scan, { status: 'error', message: msg });
      emit('scanError', { msg });
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    scan.browser = null;
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
  fs.mkdirSync(p, { recursive: true });
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
const HOST = process.env.HOST || '0.0.0.0';   // 0.0.0.0 이어야 다른 컴퓨터에서 접속된다

/**
 * 포트가 이미 쓰이고 있을 때 기본 오류는 스택 트레이스만 길게 쏟아낸다.
 * 대부분 ER 서버가 이미 떠 있는 경우이므로, 무엇을 하면 되는지 알려준다.
 */
server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`
  ${PORT}번 포트를 이미 다른 프로그램이 쓰고 있습니다.
  대개 ER 서버가 이미 실행 중인 경우입니다. 아래 중 하나를 하세요.

    1. 이미 떠 있는 서버를 그대로 쓰기
       브라우저에서  http://localhost:${PORT}  를 열어보세요.

    2. 기존 서버를 끄고 다시 시작하기
       그 서버가 떠 있는 터미널에서 Ctrl + C 를 누르거나, 아래를 실행하세요.

         lsof -ti tcp:${PORT} | xargs kill

    3. 다른 포트로 시작하기

         PORT=4000 npm start
`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const hostname = os.hostname().replace(/\.local$/, '');
  console.log('');
  console.log('  ER — 자동 스모크 테스트 서버가 실행 중입니다.');
  console.log('');
  console.log(`    이 컴퓨터에서   →  http://localhost:${PORT}`);
  lanAddresses().forEach(ip => console.log(`    같은 사내망에서 →  http://${ip}:${PORT}`));
  console.log(`    이름으로       →  http://${hostname}.local:${PORT}   (윈도우에서는 안 될 수 있음)`);
  console.log('');
  if (!canOpenWindow()) {
    console.log('  * 이 환경에는 화면이 없어 "직접 로그인" 방식은 쓸 수 없습니다.');
    console.log('    로그인이 필요한 화면은 아이디·비밀번호 방식을 쓰세요.');
    console.log('');
  }
  console.log('  종료하려면 Ctrl + C');
  console.log('');
});
