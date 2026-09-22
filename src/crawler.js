/**
 * 페이지 순회 크롤러
 * scope: 'page'(시작 URL만) | 'path'(시작 경로 하위) | 'domain'(같은 도메인 전체)
 */
const { scanPage, waitForContent } = require('./engine');
const cfg = require('../config.json');
const { explainNavigation } = require('./explain');

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
      // 시작 주소의 폴더까지를 범위로 본다. 끝에 / 를 붙여 비교해야 /admin 이 /administrator 까지 먹지 않는다.
      const basePath = start.pathname.replace(/[^/]*$/, '');
      return (target.pathname + '/').startsWith(basePath);
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
 * @param {function} [opts.checkLanded]  넘겨져 도착한 주소를 검사해도 되는지 — 안 되면 이유를 돌려준다
 */
async function crawl(browser, startUrl, scope, onProgress, opts = {}) {
  const MAX_PAGES = Number.isFinite(Number(opts.maxPages)) && Number(opts.maxPages) >= 1
    ? Math.floor(Number(opts.maxPages)) : (cfg.maxPages ?? 50);
  const shouldStop = opts.shouldStop || (() => false);
  const report = (type, data) => { if (onProgress) onProgress({ type, ...data }); };

  const visited = new Set();
  const queued = new Set();
  const retried = new Set();   // 다른 이동이 끼어들어 못 연 주소 — 한 번만 다시 시도한다
  const queue = [normalize(startUrl)];
  queued.add(queue[0]);
  const allResults = [];

  const context = browser.contexts()[0] || await browser.newContext({ ignoreHTTPSErrors: cfg.ignoreHTTPSErrors });
  const page = context.pages()[0] || await context.newPage();

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    if (shouldStop()) { report('stopped', {}); break; }

    let url = queue.shift();
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

      // 화면이 다 그려질 때까지 기다린다. 요즘 화면은 주소를 열어도 곧바로 내용이 없어서,
      // 이 대기가 없으면 메뉴가 그려지기 전에 요소를 세어 한두 개만 잡힌다.
      const ready = await waitForContent(page);
      report('ready', { url, count: ready });
    } catch (e) {
      const raw = String(e?.message || e);
      const msg = explainNavigation(raw);

      // 다른 이동이 끼어들어 중단된 진입은 검사 방식이 만든 것이지 사이트의 결함이 아니다.
      // 큐 맨 뒤에서 한 번 더 시도한다.
      if (/interrupted by another navigation|ERR_ABORTED/i.test(raw)) {
        if (!retried.has(url)) {
          retried.add(url);
          visited.delete(url);
          queue.push(url);
          report('pageError', { url, msg: '다른 이동이 끼어들어 뒤에서 다시 시도합니다' });
        } else {
          report('pageError', { url, msg: '다른 이동이 끼어들어 건너뜀' });
        }
        continue;
      }

      report('pageError', { url, msg });
      allResults.push({
        page: url, label: '(페이지 진입)', sel: url, status: 'ERROR',
        reason: `페이지를 열지 못했습니다 — ${msg}`, signals: {},
      });
      continue;
    }

    // ── 다른 사이트로 넘겨졌는지 ──
    // 세션이 만료돼 SSO 로그인으로 넘어가는 등, 연 주소와 다른 사이트에 도착할 수 있다.
    // 그대로 검사하면 남의 사이트 버튼을 실제로 누르게 되므로 검사하지 않는다.
    // 첫 페이지만은 예외다 — http→https, example.com→www.example.com 처럼 사이트가 스스로 옮겨 주는 경우라
    // 도착한 주소를 새 기준으로 삼는다.
    const landed = normalize(page.url());
    if (landed !== url && opts.checkLanded) {
      const problem = await opts.checkLanded(landed).catch(() => null);
      if (problem) {
        report('pageError', { url, msg: `${problem} (${landed})` });
        continue;
      }
    }
    if (landed !== url) {
      const sameSite = inScope(startUrl, landed, 'domain');
      const inRange = scope === 'page' ? sameSite : inScope(startUrl, landed, scope);
      if (!inRange && visited.size !== 1) {
        report('pageError', {
          url, msg: `${sameSite ? '검사 범위 밖으로' : '다른 사이트로'} 넘겨져 검사하지 않았습니다 → ${landed}`,
        });
        continue;
      }
      if (!sameSite) {
        startUrl = landed;   // 첫 페이지가 사이트를 옮겨 간 경우 — 도착한 곳을 새 기준으로
      } else if (visited.has(landed)) {
        // 여러 주소가 같은 화면(로그인 화면 등)으로 넘어가는 경우 — 같은 화면을 두 번 검사하지 않는다
        report('pageError', { url, msg: `이미 검사한 화면으로 넘겨졌습니다 → ${landed}` });
        continue;
      }
      // 결과와 복귀 기준은 실제로 도착한 주소로 남긴다
      report('redirected', { from: url, to: landed });
      visited.add(landed);
      url = landed;
    }

    // 로그인이 필요한 화면인데 로그인 상태가 아니면, 검사해 봐야 로그인 화면만 보게 된다.
    // 첫 페이지에서 이를 알아채 알려준다.
    if (visited.size === 1) {
      const looksLoggedOut = await page.evaluate(() => {
        const pw = [...document.querySelectorAll("input[type='password']")].some(e => e.offsetWidth || e.offsetHeight);
        const few = document.querySelectorAll('button, a, [role=button], [onclick]').length <= 6;
        return pw && few;
      }).catch(() => false);
      if (looksLoggedOut) {
        report('loggedOut', { url });
      }
    }

    // 링크는 클릭하기 전에 모은다. 클릭으로 화면이 바뀐 뒤에는 원래 있던 메뉴가 사라져 있을 수 있다.
    const enqueue = links => {
      for (const link of links) {
        if (!visited.has(link) && !queued.has(link)) {
          queued.add(link);
          queue.push(link);
        }
      }
    };
    enqueue(await collectLinks(page, startUrl, scope));

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

    // 클릭으로 드러난 메뉴(펼침 메뉴 등)의 링크도 더한다
    enqueue(await collectLinks(page, startUrl, scope));
  }

  if (visited.size >= MAX_PAGES && queue.length > 0) {
    report('limit', { max: MAX_PAGES, skipped: queue.length });
  }

  return allResults;
}

module.exports = { crawl, normalize, inScope };
