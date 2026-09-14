const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { chromium } = require('playwright');
const { doLogin } = require('./src/login');
const { crawl } = require('./src/crawler');
const { saveHtml, saveExcel } = require('./src/reporter');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/reports', express.static(path.join(__dirname, 'reports')));

// 스캔 결과 메모리 저장소
const scans = new Map();

app.post('/api/scan', (req, res) => {
  const { url, scope, login, excludeRules, observeMs } = req.body;
  if (!url) return res.status(400).json({ error: 'URL 필수' });

  const scanId = crypto.randomUUID().slice(0, 8);
  scans.set(scanId, { status: 'running' });
  res.json({ scanId });

  runScan(scanId, { url, scope: scope || 'path', login, excludeRules, observeMs });
});

app.get('/api/report/:scanId', (req, res) => {
  const scan = scans.get(req.params.scanId);
  if (!scan) return res.status(404).json({ error: '스캔 결과 없음' });
  res.json(scan);
});

async function runScan(scanId, options) {
  const { url, scope, login, excludeRules, observeMs = 2000 } = options;
  const emit = (event, data) => io.to(scanId).emit(event, data);

  try {
    emit('log', { msg: '브라우저 시작 중…' });
    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    if (login?.enabled && login?.username) {
      emit('log', { msg: '로그인 중…' });
      try {
        await doLogin(page, login);
        emit('log', { msg: '로그인 성공' });
      } catch (e) {
        emit('error', { msg: `로그인 실패: ${e.message}` });
        await browser.close();
        scans.set(scanId, { status: 'error', message: e.message });
        return;
      }
    } else {
      emit('log', { msg: `${url} 접속 중…` });
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    }

    emit('log', { msg: '페이지 순회 시작…' });
    const t0 = Date.now();

    const opts = { observeMs, excludeRules };
    const results = await crawl(browser, url, scope, ({ type, url: pageUrl, count }) => {
      if (type === 'page') emit('page', { url: pageUrl });
      if (type === 'done') emit('pageResult', { url: pageUrl, count });
    }, opts);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    await browser.close();

    const scannedAt = new Date().toLocaleString('ko-KR');
    const meta = { url, scope, elapsed, scannedAt };

    // 리포트 파일 저장
    const outputDir = path.join(__dirname, 'reports', scanId);
    saveHtml(results, meta, outputDir);
    saveExcel(results, meta, outputDir);

    scans.set(scanId, { status: 'done', results, meta });
    emit('done', { results, meta, scanId });

  } catch (e) {
    console.error('스캔 오류:', e.message);
    emit('error', { msg: e.message });
    scans.set(scanId, { status: 'error', message: e.message });
  }
}

io.on('connection', socket => {
  socket.on('join', scanId => socket.join(scanId));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Smoke 서버 실행 중 → http://localhost:${PORT}`);
});
