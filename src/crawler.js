/**
 * 페이지 순회 크롤러
 * scope: 'page' | 'path' | 'domain'
 */
const { scanPage } = require('./engine');
const cfg = require('../config.json');

const MAX_PAGES = cfg.maxPages ?? 50;

function isSameDomain(base, href) {
  try {
    return new URL(href).hostname === new URL(base).hostname;
  } catch { return false; }
}

function isScopedUrl(startUrl, href, scope) {
  try {
    const start = new URL(startUrl);
    const target = new URL(href);
    if (target.hostname !== start.hostname) return false;
    if (scope === 'domain') return true;
    if (scope === 'path') {
      // 시작 URL의 경로 prefix와 일치하는 경로만
      const basePath = start.pathname.replace(/\/[^/]*$/, '') || '/';
      return target.pathname.startsWith(basePath);
    }
    return false; // 'page' — 추가 순회 없음
  } catch { return false; }
}

async function collectLinks(page, startUrl, scope) {
  if (scope === 'page') return [];
  const anchors = await page.$$eval('a[href]', els =>
    els.map(a => a.href).filter(h => h && !h.startsWith('javascript:') && !h.startsWith('mailto:'))
  );
  return anchors.filter(href => isScopedUrl(startUrl, href, scope));
}

async function crawl(browser, startUrl, scope, onProgress, opts = {}) {
  const MAX_PAGES = opts.maxPages ?? cfg.maxPages ?? 50;
  const visited = new Set();
  const queue = [startUrl];
  const allResults = [];

  const context = browser.contexts()[0] || await browser.newContext({ ignoreHTTPSErrors: cfg.ignoreHTTPSErrors });
  const page = context.pages()[0] || await context.newPage();

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const url = queue.shift();
    // 해시만 다른 URL은 같은 페이지로 처리
    const urlKey = url.split('#')[0];
    if (visited.has(urlKey)) continue;
    visited.add(urlKey);

    if (onProgress) onProgress({ type: 'page', url, visited: visited.size, queued: queue.length });

    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    } catch (e) {
      console.error(`  접근 실패: ${url} — ${e.message}`);
      continue;
    }

    // 현재 페이지 요소 스캔
    const pageResults = await scanPage(page, url, opts);
    allResults.push(...pageResults);

    if (onProgress) onProgress({ type: 'done', url, count: pageResults.length });

    // 링크 수집 후 큐에 추가
    const links = await collectLinks(page, startUrl, scope);
    for (const link of links) {
      const key = link.split('#')[0];
      if (!visited.has(key) && !queue.includes(link)) {
        queue.push(link);
      }
    }
  }

  if (visited.size >= MAX_PAGES) {
    console.warn(`  최대 페이지 수(${MAX_PAGES}) 도달 — 스캔 종료`);
  }

  return allResults;
}

module.exports = { crawl };
