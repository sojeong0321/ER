/**
 * 페이지 순회 크롤러
 * scope: 'page'(시작 URL만) | 'path'(시작 경로 하위) | 'domain'(같은 도메인 전체)
 */
const { scanPage } = require('./engine');
const cfg = require('../config.json');

/** 검사 의미가 없는 링크 — 파일 다운로드·프로토콜 링크 */
const SKIP_LINK = /\.(pdf|zip|docx?|xlsx?|pptx?|hwp|csv|png|jpe?g|gif|svg|mp4|mp3|dmg|exe)(\?|$)/i;

/** 비교·중복 판정을 위해 URL을 정규화한다 (해시·추적 파라미터 제거) */
function normalize(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']
      .forEach(p => u.searchParams.delete(p));
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch { return href; }
}

function inScope(startUrl, href, scope) {
  try {
    const start = new URL(startUrl);
    const target = new URL(href);
    if (!/^https?:$/.test(target.protocol)) return false;
    if (target.hostname !== start.hostname) return false;
    if (target.port !== start.port) return false;
    if (scope === 'domain') return true;
    if (scope === 'path') {
      const basePath = start.pathname.replace(/\/[^/]*$/, '') || '/';
      return target.pathname.startsWith(basePath);
    }
    return false; // 'page' — 추가 순회 없음
  } catch { return false; }
}

async function collectLinks(page, startUrl, scope) {
  if (scope === 'page') return [];
  const hrefs = await page.$$eval('a[href]', els => els.map(a => a.href)).catch(() => []);
  return hrefs
    .filter(h => h && !SKIP_LINK.test(h))
    .map(normalize)
    .filter(h => inScope(startUrl, h, scope));
}

/**
 * @param {object} opts.observeMs        요소당 최대 관찰 시간
 * @param {string[]} opts.excludeRules   라벨 기준 제외 규칙
 * @param {number} opts.maxPages         최대 순회 페이지 수
 * @param {string} opts.screenshotDir    결함 스크린샷 저장 경로
 * @param {function} opts.shouldStop     true를 반환하면 스캔을 중단한다
 */
async function crawl(browser, startUrl, scope, onProgress, opts = {}) {
  const MAX_PAGES = opts.maxPages ?? cfg.maxPages ?? 50;
  const shouldStop = opts.shouldStop || (() => false);
  const report = (type, data) => { if (onProgress) onProgress({ type, ...data }); };

  const visited = new Set();
  const queued = new Set();
  const queue = [normalize(startUrl)];
  queued.add(queue[0]);
  const allResults = [];

  const context = browser.contexts()[0] || await browser.newContext({ ignoreHTTPSErrors: cfg.ignoreHTTPSErrors });
  const page = context.pages()[0] || await context.newPage();

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    if (shouldStop()) { report('stopped', {}); break; }

    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    report('page', { url, visited: visited.size, queued: queue.length });

    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (shouldStop()) { report('stopped', {}); break; }
      // 이후 렌더링까지 잠깐 기다린다 (SPA 대응). 끝나지 않아도 계속 진행한다.
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      if (resp && resp.status() >= 400) {
        report('pageError', { url, msg: `HTTP ${resp.status()}` });
        allResults.push({
          page: url, label: '(페이지 진입)', sel: url, status: 'ERROR',
          reason: `페이지 응답 HTTP ${resp.status()}`, signals: {},
        });
        continue;
      }
    } catch (e) {
      const msg = String(e?.message || e).split('\n')[0].slice(0, 120);
      report('pageError', { url, msg });
      allResults.push({
        page: url, label: '(페이지 진입)', sel: url, status: 'ERROR',
        reason: `접근 실패: ${msg}`, signals: {},
      });
      continue;
    }

    const pageResults = await scanPage(page, url, {
      ...opts,
      onElement: p => report('element', { url, ...p }),
    }).catch(e => {
      // 중단 중이라면 여기까지 모은 결과로 끝낸다
      if (shouldStop()) return [];
      throw e;
    });
    allResults.push(...pageResults);
    report('done', { url, count: pageResults.length });

    for (const link of await collectLinks(page, startUrl, scope)) {
      if (!visited.has(link) && !queued.has(link)) {
        queued.add(link);
        queue.push(link);
      }
    }
  }

  if (visited.size >= MAX_PAGES && queue.length > 0) {
    report('limit', { max: MAX_PAGES, skipped: queue.length });
  }

  return allResults;
}

module.exports = { crawl };
