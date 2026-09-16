/**
 * 판정 엔진 — 클릭 후 변화 신호를 관찰해 PASS / ERROR / NO-RESPONSE 를 판정한다.
 *
 * 이전 버전의 판정은 `page.content()` 문자열 전체 비교였다. 그 방식은 화면에
 * 시계·배너·애니메이션이 하나만 있어도 모든 요소가 PASS로 나온다. 실제 사이트에서
 * 무감(NO-RESPONSE)을 못 잡는 치명적 오탐이라, 아래 두 가지로 교체했다.
 *
 *   1) MutationObserver 로 "무엇이 몇 번 바뀌었는지"를 종류별로 센다.
 *   2) 페이지마다 클릭 없이 한 번 관찰해 자연 발생하는 변화량(노이즈)을 먼저 재고,
 *      클릭 후 변화가 그 노이즈를 넘어설 때만 신호로 인정한다.
 *
 * 네트워크 신호도 같은 이유로 클릭 시점 이후 발생한 요청만 세고, 트래킹·폴링성
 * 요청은 제외한다.
 */
const defaultCfg = require('../config.json');
const path = require('path');

const CLICKABLE = 'button, a, [role=button], [onclick], input[type=button], input[type=submit], input[type=reset]';

/** 클릭과 무관하게 상시 발생하는 트래킹·수집성 요청 (NET 신호에서 제외) */
const NOISE_REQUEST = /google-analytics|googletagmanager|gtag\/js|doubleclick|facebook\.(net|com)\/tr|hotjar|clarity\.ms|sentry\.io|datadoghq|newrelic|segment\.(io|com)|amplitude|mixpanel|criteo|adsystem|\/collect(\?|$)|\/beacon(\?|$)|\/ping(\?|$)|\/heartbeat(\?|$)/i;

/** 코드 결함이 아닌 네트워크·리소스 잡음 콘솔 메시지 */
const NOISE_CONSOLE = /net::ERR|Failed to load resource|ERR_|favicon|Download the React DevTools|\[HMR\]|DevTools/i;

const NOISE_SAMPLE_MS = 1000;   // 페이지 노이즈 측정 시간
const POLL_MS = 100;            // 적응형 대기 폴링 간격
const SETTLE_MS = 350;          // 신호 감지 후 추가 관찰 시간
const MIN_OBSERVE_MS = 400;     // 최소 관찰 시간 (즉시 반응도 놓치지 않도록)

/* ────────────────────────── 브라우저 측 계측 ────────────────────────── */

/**
 * 검사 대상 요소에 data-er-i 인덱스를 부여한다.
 * 클릭 때마다 $$()[i] 로 다시 집으면 DOM이 바뀔 때 엉뚱한 요소를 클릭하게 되므로,
 * 매 요소 검사 전에 이 마커를 다시 찍어 같은 요소를 가리키도록 고정한다.
 */
async function stampElements(page, selector) {
  return page.evaluate(sel => {
    const els = [...document.querySelectorAll(sel)];
    els.forEach((el, i) => el.setAttribute('data-er-i', String(i)));
    return els.length;
  }, selector).catch(() => 0);
}

/**
 * MutationObserver 설치 — 변화가 "어디서" 일어났는지를 위치 지문별로 누적한다.
 *
 * 변화 횟수만 세면 "시계가 2번 바뀜 vs 버튼이 1번 반응함"을 구분할 수 없다.
 * 시계는 늘 같은 노드에서, 클릭 반응은 다른 노드에서 일어나므로 위치로 구분하면
 * 경계값 튜닝 없이 노이즈를 걸러낼 수 있다.
 */
async function startWatching(page) {
  return page.evaluate(() => {
    try { window.__erObs?.disconnect(); } catch {}

    // 변화가 일어난 지점을 조상 3단계까지의 지문으로 표현한다
    const fingerprint = node => {
      let el = node && node.nodeType === 1 ? node : node?.parentElement;
      const parts = [];
      for (let i = 0; el && i < 3; i++, el = el.parentElement) {
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
        parts.push(el.tagName + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : ''));
      }
      return parts.join('<') || '#detached';
    };

    const hits = Object.create(null);
    window.__erHits = hits;

    const obs = new MutationObserver(list => {
      for (const m of list) {
        // 계측용 마커 자체의 변경은 신호로 세지 않는다
        if (m.type === 'attributes' && m.attributeName === 'data-er-i') continue;
        const key = m.type + '@' + fingerprint(m.target);
        hits[key] = (hits[key] || 0) + 1;
      }
    });
    obs.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
    window.__erObs = obs;

    // 화면 상태 지문 — 모달·토스트처럼 DOM 변화가 작아도 눈에 띄는 변화를 잡는다
    const vis = () => ({
      h: document.documentElement.scrollHeight,
      t: (document.body?.innerText || '').length,
      d: document.querySelectorAll('dialog[open], [role=dialog], [aria-modal="true"]').length,
      f: document.activeElement ? document.activeElement.tagName + (document.activeElement.id || '') : '',
    });
    window.__erVis = vis;
    window.__erVis0 = vis();
    return true;
  }).catch(() => false);
}

/** 누적된 변화를 읽어온다. 페이지가 넘어갔으면 null */
async function readWatch(page) {
  return page.evaluate(() => {
    if (!window.__erHits) return null;
    const v0 = window.__erVis0, v = window.__erVis ? window.__erVis() : null;
    return {
      hits: { ...window.__erHits },
      visChanged: !!(v0 && v && (v.h !== v0.h || v.d !== v0.d || v.f !== v0.f || v.t !== v0.t)),
    };
  }).catch(() => null);
}

/* ────────────────────────── 판정 보조 ────────────────────────── */

/**
 * 페이지가 클릭 없이도 스스로 만들어내는 변화를 미리 관찰해둔다.
 * 여기서 본 위치(시계·캐러셀·폴링 배너 등)는 이후 클릭 판정에서 신호로 세지 않는다.
 */
async function measureNoise(page) {
  const empty = { sigs: new Set(), net: 0, visNoisy: false };
  if (!(await startWatching(page))) return empty;

  let net = 0;
  const onReq = req => { if (!NOISE_REQUEST.test(req.url())) net++; };
  page.on('request', onReq);
  await page.waitForTimeout(NOISE_SAMPLE_MS);
  page.off('request', onReq);

  const m = await readWatch(page);
  if (!m) return empty;
  return {
    sigs: new Set(Object.keys(m.hits)),
    net,
    // 화면 지문이 저절로 흔들리는 페이지면 화면 신호는 신뢰하지 않는다
    visNoisy: m.visChanged === true,
  };
}

/**
 * 관찰된 변화 중 "페이지가 원래 하던 변화"를 뺀 나머지가 있는지 본다.
 * 노이즈로 본 위치에서 난 변화는 몇 번이든 무시하고, 새로운 위치의 변화만 신호로 인정한다.
 */
function freshSignals(mut, noise) {
  if (!mut) return { dom: false, vis: false, where: [] };
  const where = Object.keys(mut.hits).filter(k => !noise.sigs.has(k));
  return {
    dom: where.length > 0,
    vis: mut.visChanged === true && !noise.visNoisy,
    where,
  };
}

function buildSelector(tag, id, cls) {
  if (id) return `${tag}#${CSS_escape(id)}`;
  const first = String(cls || '').trim().split(/\s+/)[0];
  return tag + (first ? '.' + first : '');
}
// 서버 측에는 CSS.escape 가 없으므로 최소한의 처리만 한다
function CSS_escape(s) { return String(s).replace(/([ !"#$%&'()*+,./:;<=>?@[\]^`{|}~])/g, '\\$1'); }

/* ────────────────────────── 메인 ────────────────────────── */

async function scanPage(page, pageUrl, opts = {}) {
  const OBSERVE_MS = opts.observeMs ?? defaultCfg.observeMs ?? 2000;
  const EXCLUDE_RULES = (opts.excludeRules ?? defaultCfg.excludeRules ?? []).filter(Boolean);
  const shotDir = opts.screenshotDir || null;
  const onElement = opts.onElement || null;
  const shouldStop = opts.shouldStop || (() => false);

  const results = [];
  const startHost = (() => { try { return new URL(pageUrl).hostname; } catch { return ''; } })();

  // 팝업·새 탭은 검사 흐름을 깨므로 열리는 즉시 닫는다
  const ctx = page.context();
  const onPopup = p => { p.close().catch(() => {}); };
  ctx.on('page', onPopup);

  try {
    const total = await stampElements(page, CLICKABLE);
    const noise = await measureNoise(page);

    for (let i = 0; i < total; i++) {
      if (shouldStop()) break;

      const locator = page.locator(`[data-er-i="${i}"]`).first();
      if (!(await locator.count().catch(() => 0))) continue;

      // ── 요소 메타 수집 ──
      const info = await locator.evaluate(n => ({
        tag: n.tagName.toLowerCase(),
        id: n.id || '',
        cls: String(n.className?.baseVal ?? n.className ?? ''),
        text: (n.innerText || n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        aria: n.getAttribute('aria-label') || '',
        title: n.getAttribute('title') || '',
        href: n.getAttribute('href') || '',
        target: n.getAttribute('target') || '',
        disabled: n.disabled === true || n.getAttribute('aria-disabled') === 'true',
        type: n.getAttribute('type') || '',
      })).catch(() => null);
      if (!info) continue;

      const label = (info.text || info.aria || info.title || info.id || `(${info.tag})`).slice(0, 80);
      const sel = buildSelector(info.tag, info.id, info.cls);
      const base = { page: pageUrl, label, sel, tag: info.tag };
      const push = r => {
        results.push(r);
        if (onElement) onElement({ index: i, total, result: r });
      };

      // ── 검사 전 제외 판정 ──
      if (info.disabled) {
        push({ ...base, status: 'EXCLUDED', reason: 'disabled 요소', signals: {} });
        continue;
      }
      const hitRule = EXCLUDE_RULES.find(r => label.includes(r));
      if (hitRule) {
        push({ ...base, status: 'EXCLUDED', reason: `제외 규칙: '${hitRule}'`, signals: {} });
        continue;
      }
      // 외부 도메인·새 탭 링크는 클릭하면 스캔 흐름을 벗어난다
      if (info.tag === 'a' && info.href) {
        const abs = (() => { try { return new URL(info.href, pageUrl); } catch { return null; } })();
        if (abs && !/^(https?|file):/.test(abs.protocol)) {
          push({ ...base, status: 'EXCLUDED', reason: `${abs.protocol} 링크`, signals: {} });
          continue;
        }
        if (abs && startHost && abs.hostname !== startHost) {
          push({ ...base, status: 'EXCLUDED', reason: '외부 도메인 링크', signals: {} });
          continue;
        }
        if (info.target === '_blank') {
          push({ ...base, status: 'EXCLUDED', reason: '새 탭 링크', signals: {} });
          continue;
        }
      }
      if (!(await locator.isVisible().catch(() => false))) {
        push({ ...base, status: 'EXCLUDED', reason: '화면에 보이지 않음', signals: {} });
        continue;
      }

      // ── 관찰 준비 ──
      const urlBefore = page.url();
      let netHits = 0, jsError = null, badStatus = null, failedOwn = null;
      let clickedAt = 0;

      const onReq = req => {
        if (!clickedAt) return;                       // 클릭 전 요청은 노이즈
        if (NOISE_REQUEST.test(req.url())) return;
        netHits++;
      };
      const onResp = resp => {
        if (!clickedAt || badStatus) return;
        if (resp.status() >= 400 && !NOISE_REQUEST.test(resp.url())) {
          badStatus = { status: resp.status(), url: resp.url() };
        }
      };
      const onFailed = req => {
        if (!clickedAt || failedOwn) return;
        if (NOISE_REQUEST.test(req.url())) return;
        // 대상 사이트 자신에 대한 요청 실패만 결함 후보로 본다
        const h = (() => { try { return new URL(req.url()).hostname; } catch { return ''; } })();
        if (h && startHost && h === startHost) failedOwn = req.url();
      };
      const onConsole = msg => {
        if (!clickedAt || jsError || msg.type() !== 'error') return;
        const t = msg.text();
        if (NOISE_CONSOLE.test(t)) return;
        jsError = t.slice(0, 200);
      };
      const onPageErr = err => { if (clickedAt && !jsError) jsError = String(err?.message || err).slice(0, 200); };

      page.on('request', onReq);
      page.on('response', onResp);
      page.on('requestfailed', onFailed);
      page.on('console', onConsole);
      page.on('pageerror', onPageErr);

      await startWatching(page);

      // ── 클릭 ──
      let clickFail = null;
      clickedAt = Date.now();
      try {
        await locator.click({ timeout: 2500, noWaitAfter: true });
      } catch (e) {
        clickFail = String(e?.message || e).split('\n')[0].slice(0, 120);
      }

      // ── 적응형 관찰: 신호가 잡히면 기다리지 않고 끝낸다 ──
      let mut = null, navigated = false;
      const t0 = Date.now();
      while (true) {
        const waited = Date.now() - t0;
        if (waited >= OBSERVE_MS) break;
        await page.waitForTimeout(POLL_MS).catch(() => {});
        const m = await readWatch(page);
        if (m === null) { navigated = true; break; }   // 페이지가 넘어감
        mut = m;
        if (waited < MIN_OBSERVE_MS) continue;
        const sig = freshSignals(m, noise);
        if (sig.dom || sig.vis || netHits > 0 || page.url() !== urlBefore) {
          await page.waitForTimeout(SETTLE_MS).catch(() => {});
          mut = (await readWatch(page)) || m;
          break;
        }
      }
      const observedMs = Date.now() - t0;

      page.off('request', onReq);
      page.off('response', onResp);
      page.off('requestfailed', onFailed);
      page.off('console', onConsole);
      page.off('pageerror', onPageErr);

      if (clickFail) {
        push({ ...base, status: 'UNCLICKABLE', reason: clickFail, signals: {} });
        continue;
      }

      const urlChanged = navigated || page.url() !== urlBefore;
      const ex = mut ? freshSignals(mut, noise) : { dom: navigated, vis: navigated };
      const signals = {
        dom: ex.dom ? 1 : 0,
        net: netHits > 0 ? 1 : 0,
        url: urlChanged ? 1 : 0,
        console: jsError ? 1 : 0,
        vis: ex.vis ? 1 : 0,
      };

      // ── 판정 ──
      let status, reason;
      if (jsError) {
        status = 'ERROR'; reason = `JS 예외: ${jsError}`;
      } else if (badStatus) {
        status = 'ERROR'; reason = `HTTP ${badStatus.status} — ${shortUrl(badStatus.url)}`;
      } else if (failedOwn) {
        status = 'ERROR'; reason = `요청 실패 — ${shortUrl(failedOwn)}`;
      } else if (!signals.dom && !signals.net && !signals.url && !signals.vis) {
        status = 'NO-RESPONSE'; reason = `클릭 후 ${(observedMs / 1000).toFixed(1)}초 동안 무변화`;
      } else {
        status = 'PASS'; reason = describe(signals);
      }

      // ── 결함만 스크린샷 ──
      let screenshot = null;
      if (shotDir && (status === 'ERROR' || status === 'NO-RESPONSE')) {
        const file = `${results.length}-${status}.png`;
        const ok = await page.screenshot({ path: path.join(shotDir, file), timeout: 5000 })
          .then(() => true).catch(() => false);
        if (ok) screenshot = file;
      }

      push({ ...base, status, reason, signals, observedMs, screenshot });

      // ── 페이지를 벗어났으면 원위치 복귀 후 마커 재부여 ──
      if (urlChanged) {
        const back = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
          .then(() => true).catch(() => false);
        if (!back) break;                     // 복귀 실패하면 이 페이지 검사 종료
        await stampElements(page, CLICKABLE);
      }
    }
  } finally {
    ctx.off('page', onPopup);
  }

  return results;
}

function shortUrl(u) {
  try { const x = new URL(u); return x.pathname.length > 1 ? x.hostname + x.pathname : x.hostname; }
  catch { return String(u).slice(0, 60); }
}

function describe(s) {
  const hit = [];
  if (s.dom) hit.push('DOM');
  if (s.net) hit.push('NET');
  if (s.url) hit.push('URL');
  if (s.vis) hit.push('화면');
  return hit.join(' + ') + ' 변화 감지';
}

module.exports = { scanPage, CLICKABLE };
