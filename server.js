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
const { doLogin } = require('./src/login');
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
  const { url, scope, login, excludeRules, observeMs, maxPages } = req.body || {};
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

/** 회귀 테스트용 대상 페이지 */
app.get('/test-target.html', (req, res) => res.sendFile(path.join(__dirname, 'test-target.html')));

/** 회귀 테스트(test-target.html)에서 서버 에러 판정을 검증하기 위한 고정 500 응답 */
app.get('/api/_test/500', (req, res) => res.status(500).json({ error: 'intentional test error' }));
app.get('/api/_test/ok', (req, res) => res.json({ ok: true }));

async function runScan(scanId, options) {
  const scan = scans.get(scanId);
  const emit = emitter(scanId);
  const { url, scope, login, excludeRules, observeMs, maxPages } = options;
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

    const context = await browser.newContext({
      ignoreHTTPSErrors: cfg.ignoreHTTPSErrors !== false,
      acceptDownloads: false,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    if (login?.enabled && login?.username) {
      emit('log', { msg: '로그인 중…' });
      await doLogin(page, { ...cfg.login, ...login });
      emit('log', { msg: '로그인 성공 — 인증된 세션으로 검사합니다.' });
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
