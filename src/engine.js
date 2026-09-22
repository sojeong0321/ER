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
const crypto = require('crypto');
const { explainClick, explainRequestFailure } = require('./explain');

const CLICKABLE = 'button, a, [role=button], [onclick], input[type=button], input[type=submit], input[type=reset]';

/** 클릭과 무관하게 상시 발생하는 트래킹·수집성 요청 (NET 신호에서 제외) */
const NOISE_REQUEST = /google-analytics|googletagmanager|gtag\/js|doubleclick|facebook\.(net|com)\/tr|hotjar|clarity\.ms|sentry\.io|datadoghq|newrelic|segment\.(io|com)|amplitude|mixpanel|criteo|adsystem|\/collect(\?|$)|\/beacon(\?|$)|\/ping(\?|$)|\/heartbeat(\?|$)/i;

/** 코드 결함이 아닌 네트워크·리소스 잡음 콘솔 메시지 */
const NOISE_CONSOLE = /net::ERR|Failed to load resource|ERR_|favicon|Download the React DevTools|\[HMR\]|DevTools/i;

/** 한국·영국 등에서 쓰는 2단계 최상위 도메인 (co.kr, co.jp …) */
const TWO_LEVEL_TLD = /^(co|or|ne|go|re|pe|ac|hs|ms|es|sc|com|net|org|gov|edu)\.(kr|jp|uk|au|nz|in|br|za|cn|tw|il|tr)$/;

/**
 * 등록 도메인을 구한다. admin.example.co.kr → example.co.kr
 * 사내 시스템은 admin·api 처럼 서브도메인으로 나뉘는 경우가 많아,
 * 호스트 이름을 그대로 비교하면 같은 서비스인데 외부로 분류된다.
 */
function siteOf(host) {
  const h = String(host || '');
  // IP 주소는 그대로 쓴다 (사내 시스템은 IP 로 접근하는 경우가 많다)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  return TWO_LEVEL_TLD.test(last2) ? parts.slice(-3).join('.') : last2;
}

const NOISE_SAMPLE_MS = 1000;   // 페이지 노이즈 측정 시간
const LATE_GRACE_MS = 1000;     // 관찰이 끝난 직후 늦게 도착한 반응은 배경 소음으로 배우지 않는다
const POLL_MS = 100;            // 적응형 대기 폴링 간격
const SETTLE_MS = 350;          // 신호 감지 후 추가 관찰 시간
const MIN_OBSERVE_MS = 400;     // 최소 관찰 시간 (즉시 반응도 놓치지 않도록)

/* ────────────────────────── 브라우저 측 계측 ────────────────────────── */

/**
 * 화면에 떠 있는 모달과, 그 안에 든 검사 대상 요소(data-er-i).
 * 숨겨 둔 [role=dialog] 는 세지 않는다.
 */
function readOpenModals(page) {
  return page.evaluate(() => {
    const open = [...document.querySelectorAll('dialog[open], [role=dialog], [aria-modal="true"]')]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const inside = [...document.querySelectorAll('[data-er-i]')]
      .filter(el => open.some(m => m.contains(el)))
      .map(el => Number(el.getAttribute('data-er-i')));
    return { count: open.length, inside };
  }).catch(() => ({ count: 0, inside: [] }));
}

/**
 * 화면이 다 그려질 때까지 기다린다.
 *
 * 요즘 화면은 주소를 열어도 곧바로 내용이 없다. 메뉴와 목록을 나중에 그리므로
 * 그 전에 요소를 세면 한두 개밖에 잡히지 않는다. 클릭할 수 있는 요소 수가
 * 더 늘지 않을 때까지 지켜본다.
 */
async function waitForContent(page, maxMs = 10000) {
  const MIN_WATCH_MS = 1500;   // 로딩 초반에 잠깐 멈춘 것을 "다 그려졌다"로 오해하지 않도록
  const STEP_MS = 300;
  const STABLE_ROUNDS = 3;     // 이만큼 연속으로 그대로여야 인정한다

  const t0 = Date.now();
  let prev = -1, stable = 0;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(STEP_MS);
    const n = await page.$$eval(CLICKABLE, els => els.length).catch(() => 0);
    stable = (n > 0 && n === prev) ? stable + 1 : 0;
    prev = n;
    if (stable >= STABLE_ROUNDS && Date.now() - t0 >= MIN_WATCH_MS) return n;
  }
  return prev;
}

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
      // 포커스는 신호로 세지 않는다. 버튼을 누르면 거의 항상 포커스가 옮겨가므로
      // 아무 동작도 하지 않는 버튼까지 "반응했다" 로 판정하게 된다.
      // 앵커 링크·"맨 위로" 버튼은 스크롤만 움직인다. 이걸 빼면 정상 동작이 무감으로 잡힌다.
      y: Math.round(window.scrollY || document.documentElement.scrollTop || 0),
      x: Math.round(window.scrollX || document.documentElement.scrollLeft || 0),
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
      visChanged: !!(v0 && v && (v.h !== v0.h || v.d !== v0.d || v.t !== v0.t)),
      // 스크롤은 별도로 본다. 페이지가 저절로 스크롤되는 경우는 드물어 노이즈 위험이 낮고,
      // 반대로 앵커 이동은 이것 말고는 잡을 신호가 없다.
      scrolled: !!(v0 && v && (Math.abs(v.y - v0.y) > 8 || Math.abs(v.x - v0.x) > 8)),
    };
  }).catch(() => null);
}

/* ────────────────────────── 판정 보조 ────────────────────────── */

/**
 * 페이지가 클릭 없이도 스스로 만들어내는 변화를 미리 관찰해둔다.
 * 여기서 본 위치(시계·캐러셀·폴링 배너 등)는 이후 클릭 판정에서 신호로 세지 않는다.
 */
async function measureNoise(page) {
  const reqs = new Set(), errs = new Set();
  const empty = { sigs: new Set(), reqs, errs, visNoisy: false, scrollNoisy: false };
  if (!(await startWatching(page))) return empty;

  // 클릭 없이 나가는 요청(폴링)과 저절로 나는 콘솔 에러를 기록해 둔다.
  // 이걸 빼지 않으면 폴링하는 화면에서는 아무 반응 없는 버튼도 "서버 요청 있음" 으로 정상 판정되고,
  // 배경에서 에러가 반복되는 화면에서는 모든 버튼이 에러로 잡힌다.
  const onReq = req => reqs.add(requestKey(req));
  const onConsole = msg => { if (msg.type() === 'error') errs.add(errorKey(msg.text())); };
  const onPageErr = err => errs.add(errorKey(err?.message || err));
  page.on('request', onReq);
  page.on('console', onConsole);
  page.on('pageerror', onPageErr);
  await page.waitForTimeout(NOISE_SAMPLE_MS);
  page.off('request', onReq);
  page.off('console', onConsole);
  page.off('pageerror', onPageErr);

  const m = await readWatch(page);
  if (!m) return empty;
  return {
    sigs: new Set(Object.keys(m.hits)),
    reqs, errs,
    // 화면 지문이 저절로 흔들리는 페이지면 그 신호는 신뢰하지 않는다
    visNoisy: m.visChanged === true,
    scrollNoisy: m.scrolled === true,   // 자동 스크롤 배너가 도는 페이지
  };
}

/** 같은 종류의 요청인지 가리는 열쇠 — 폴링은 쿼리(타임스탬프 등)만 바뀌므로 경로까지만 본다 */
function requestKey(req) {
  try { const u = new URL(req.url()); return `${req.method()} ${u.origin}${u.pathname}`; }
  catch { return `${req.method()} ${req.url()}`; }
}
/** 같은 에러인지 가리는 열쇠 — 반복되는 에러는 숫자(시각·횟수)만 바뀌는 경우가 많다 */
function errorKey(text) {
  return String(text || '').slice(0, 200).replace(/\d+/g, '#');
}

/** 숫자 옵션을 받아들일 범위로 맞춘다. 숫자가 아니면 기본값 — NaN 이 들어오면 관찰이 끝나지 않는다 */
function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 관찰된 변화 중 "페이지가 원래 하던 변화"를 뺀 나머지가 있는지 본다.
 * 노이즈로 본 위치에서 난 변화는 몇 번이든 무시하고, 새로운 위치의 변화만 신호로 인정한다.
 */
function freshSignals(mut, noise) {
  if (!mut) return { dom: false, vis: false, scroll: false, where: [] };
  const where = Object.keys(mut.hits).filter(k => !noise.sigs.has(k));
  return {
    dom: where.length > 0,
    vis: mut.visChanged === true && !noise.visNoisy,
    scroll: mut.scrolled === true && !noise.scrollNoisy,
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
  const OBSERVE_MS = clampNum(opts.observeMs, 300, 60000, clampNum(defaultCfg.observeMs, 300, 60000, 2000));
  const EXCLUDE_RULES = (opts.excludeRules ?? defaultCfg.excludeRules ?? []).filter(Boolean);
  const shotDir = opts.screenshotDir || null;
  // 스크린샷 폴더는 검사 전체가 함께 쓴다. 페이지마다 순번이 0 부터 다시 시작하므로
  // 페이지 주소로 이름을 나누지 않으면 뒤 페이지의 결함 화면이 앞 페이지 것을 덮어쓴다.
  const shotTag = crypto.createHash('sha1').update(pageUrl).digest('hex').slice(0, 6);
  // 새 창으로 뜨는 화면(결제창 등)을 검사하려면 새 탭 링크를 눌러봐야 한다
  const CLICK_NEW_TAB = opts.clickNewTab === true;
  const CLICK_EXTERNAL = opts.clickExternal === true;
  const onElement = opts.onElement || null;
  const shouldStop = opts.shouldStop || (() => false);

  const results = [];
  const startHost = (() => { try { return new URL(pageUrl).hostname; } catch { return ''; } })();
  const startSite = siteOf(startHost);

  // 팝업·새 탭은 검사 흐름을 깨므로 닫되, "열렸다"는 사실은 신호로 남긴다.
  // 결제창처럼 새 창으로 뜨는 화면은 이것 말고는 반응을 확인할 방법이 없다.
  const ctx = page.context();
  let clickInProgress = false;
  let popupSeen = null;
  let dialogSeen = null;

  // alert·confirm 으로만 반응하는 버튼이 많다(사내 시스템에서 특히). 이것도 반응으로 센다.
  // confirm 은 "취소" 로 닫는다 — 삭제 확인 같은 창을 대신 승인하지 않도록.
  // 페이지를 떠날지 묻는 창(beforeunload)은 받아들여야 원래 화면으로 돌아갈 수 있다.
  const onDialog = d => {
    if (clickInProgress && d.type() !== 'beforeunload') dialogSeen = { type: d.type(), message: d.message() };
    (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {});
  };
  page.on('dialog', onDialog);
  const onPopup = async p => {
    if (clickInProgress) {
      const url = await Promise.resolve(p.url()).catch(() => '');
      popupSeen = url || '(빈 창)';
    }
    p.close().catch(() => {});
  };
  ctx.on('page', onPopup);
  let bgOff = () => {};

  try {
    const total = await stampElements(page, CLICKABLE);
    const noise = await measureNoise(page);

    // 처음 1초 동안 못 본 폴링·배경 에러도 있다. 클릭하지 않는 동안 일어난 것은 계속 배경으로 배운다.
    // 관찰이 끝난 직후에 늦게 도착한 것은 방금 누른 버튼의 반응일 수 있어 배우지 않는다.
    // 원래 화면으로 되돌리는 동안(뒤로가기·다시 열기)도 배우지 않는다 — 화면을 처음 그릴 때 부르는
    // 데이터 요청까지 소음으로 배우면, 같은 요청을 다시 부르는 "조회" 버튼을 무감으로 잘못 잡는다.
    let learnAfter = 0;
    const pauseLearning = () => { learnAfter = Infinity; };
    const resumeLearning = () => { learnAfter = Date.now() + LATE_GRACE_MS; };
    const learning = () => !clickInProgress && Date.now() >= learnAfter;
    const onBgReq = req => { if (learning()) noise.reqs.add(requestKey(req)); };
    const onBgConsole = msg => { if (msg.type() === 'error' && learning()) noise.errs.add(errorKey(msg.text())); };
    const onBgPageErr = err => { if (learning()) noise.errs.add(errorKey(err?.message || err)); };
    page.on('request', onBgReq);
    page.on('console', onBgConsole);
    page.on('pageerror', onBgPageErr);
    bgOff = () => {
      page.off('request', onBgReq);
      page.off('console', onBgConsole);
      page.off('pageerror', onBgPageErr);
    };
    // 처음부터 떠 있는 모달(쿠키 동의 등)은 페이지의 원래 모습으로 본다
    const modalsAtLoad = (await readOpenModals(page)).count;

    // 검사 차례. 지금 숨어 있는 요소는 뒤로 미뤘다가 한 번 더 본다.
    // 탭으로 화면을 나누는 곳에서는 다른 탭을 눌러야 드러나는 요소가 많다.
    const queue = [...Array(total).keys()];
    const retried = new Set();

    for (let qi = 0; qi < queue.length; qi++) {
      if (shouldStop()) break;
      const i = queue[qi];

      // 미뤄 둔 차례에 들어서면 그동안 화면이 바뀌었을 수 있으니 마커를 다시 찍는다
      if (qi === total) await stampElements(page, CLICKABLE);

      let locator = page.locator(`[data-er-i="${i}"]`).first();
      if (!(await locator.count().catch(() => 0))) {
        // 화면이 아직 그려지는 중일 수 있다. 한 번 더 기다린 뒤 다시 찾는다.
        await waitForContent(page, 3000);
        await stampElements(page, CLICKABLE);
        locator = page.locator(`[data-er-i="${i}"]`).first();
        if (!(await locator.count().catch(() => 0))) continue;
      }

      // ── 요소 메타 수집 ──
      const info = await locator.evaluate(n => ({
        tag: n.tagName.toLowerCase(),
        id: n.id || '',
        cls: String(n.className?.baseVal ?? n.className ?? ''),
        text: (n.innerText || n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        aria: n.getAttribute('aria-label') || '',
        title: n.getAttribute('title') || '',
        value: n.value || '',
        href: n.getAttribute('href') || '',
        target: n.getAttribute('target') || '',
        disabled: n.disabled === true || n.getAttribute('aria-disabled') === 'true',
        type: n.getAttribute('type') || '',
      })).catch(() => null);
      if (!info) continue;

      const label = (info.text || info.aria || info.title || info.value || info.id || `(${info.tag})`).slice(0, 80);
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
      // 제외 단어는 보이는 글자뿐 아니라 aria-label·title·value·id·class 까지 훑는다.
      // 아이콘만 있는 삭제 버튼처럼 글자가 없는 경우를 놓치지 않기 위함이다.
      const haystack = [info.text, info.aria, info.title, info.value, info.id, info.cls]
        .filter(Boolean).join(' ').toLowerCase();
      const hitRule = EXCLUDE_RULES.find(r => haystack.includes(String(r).toLowerCase()));
      if (hitRule) {
        push({ ...base, status: 'EXCLUDED', reason: `제외 단어 '${hitRule}' 포함`, signals: {} });
        continue;
      }
      // 링크 중 클릭하면 스캔 흐름을 벗어나는 것만 제외한다.
      // javascript: 링크는 제외하지 않는다 — <a href="javascript:void(0)" onclick="…"> 는
      // 사내 시스템에서 매우 흔하고, 바로 무감이 잘 나는 검사 대상이다.
      if (info.tag === 'a' && info.href) {
        const raw = info.href.trim();
        const abs = (() => { try { return new URL(raw, pageUrl); } catch { return null; } })();

        if (/^(mailto|tel|sms|ftp|file):/i.test(raw)) {
          push({ ...base, status: 'EXCLUDED', reason: `${raw.split(':')[0]} 링크`, signals: {} });
          continue;
        }
        if (!CLICK_EXTERNAL && abs && /^https?:$/.test(abs.protocol) && startSite && siteOf(abs.hostname) !== startSite) {
          push({ ...base, status: 'EXCLUDED', reason: `다른 사이트 링크 (${abs.hostname})`, signals: {} });
          continue;
        }
        if (!CLICK_NEW_TAB && info.target === '_blank') {
          push({ ...base, status: 'EXCLUDED', reason: '새 탭 링크', signals: {} });
          continue;
        }
      }
      // ── 앞선 클릭이 열어 둔 모달이 있으면, 모달 밖 요소를 누르기 전에 닫는다 ──
      // 열어 둔 채 누르면 모달에 가려 "클릭 불가" 로 잘못 잡힌다.
      // Esc 로 먼저 닫아 보고, 안 닫히는 모달이면 페이지를 다시 연다.
      let modals = await readOpenModals(page);
      if (modals.count > modalsAtLoad && !modals.inside.includes(i)) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300).catch(() => {});
        modals = await readOpenModals(page);
        if (modals.count > modalsAtLoad) {
          if (shouldStop()) break;
          pauseLearning();
          const back = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
            .then(() => true).catch(() => false);
          if (back) {
            await waitForContent(page);
            await stampElements(page, CLICKABLE);
            locator = page.locator(`[data-er-i="${i}"]`).first();
          }
          resumeLearning();
        }
      }

      if (!(await locator.isVisible().catch(() => false))) {
        if (!retried.has(i)) {
          retried.add(i);
          queue.push(i);            // 한 바퀴 뒤에 다시 본다
          continue;
        }
        push({ ...base, status: 'EXCLUDED', reason: await whyHidden(locator), signals: {} });
        continue;
      }

      // ── 관찰 준비 ──
      const urlBefore = page.url();
      let netHits = 0, jsError = null, badStatus = null, failedOwn = null;
      let clickedAt = 0;

      const onReq = req => {
        if (!clickedAt) return;                       // 클릭 전 요청은 노이즈
        if (NOISE_REQUEST.test(req.url()) || noise.reqs.has(requestKey(req))) return;
        netHits++;
      };
      const onResp = resp => {
        if (!clickedAt || badStatus) return;
        if (noise.reqs.has(requestKey(resp.request()))) return;   // 배경 폴링의 실패는 이 버튼 탓이 아니다
        if (resp.status() >= 400 && !NOISE_REQUEST.test(resp.url())) {
          badStatus = { status: resp.status(), url: resp.url() };
        }
      };
      const onFailed = req => {
        if (!clickedAt || failedOwn) return;
        if (NOISE_REQUEST.test(req.url()) || noise.reqs.has(requestKey(req))) return;

        // 링크를 클릭하면 브라우저가 그 페이지로 이동을 시작한다. 관찰이 끝나고 우리가
        // 원래 페이지로 되돌리면 진행 중이던 요청이 "취소" 된다. 사이트의 결함이 아니라
        // 검사 방식이 만들어낸 실패이므로 세지 않는다.
        const why = req.failure()?.errorText || '';
        if (/ERR_ABORTED|ERR_CANCELED|interrupted|net::ERR_BLOCKED_BY_CLIENT/i.test(why)) return;

        // 페이지 이동 자체의 실패도 여기서 다루지 않는다. 이동이 됐는지는 URL 신호로,
        // 이동한 페이지가 멀쩡한지는 그 페이지에 들어갈 때 따로 확인한다.
        if (req.isNavigationRequest()) return;

        // 대상 사이트 자신에 대한 요청 실패만 결함 후보로 본다
        const h = (() => { try { return new URL(req.url()).hostname; } catch { return ''; } })();
        if (h && startSite && siteOf(h) === startSite) failedOwn = { url: req.url(), why: explainRequestFailure(why) };
      };
      const onConsole = msg => {
        if (!clickedAt || jsError || msg.type() !== 'error') return;
        const t = msg.text();
        if (NOISE_CONSOLE.test(t) || noise.errs.has(errorKey(t))) return;
        jsError = t.slice(0, 200);
      };
      const onPageErr = err => {
        if (!clickedAt || jsError) return;
        const t = String(err?.message || err);
        if (noise.errs.has(errorKey(t))) return;
        jsError = t.slice(0, 200);
      };

      page.on('request', onReq);
      page.on('response', onResp);
      page.on('requestfailed', onFailed);
      page.on('console', onConsole);
      page.on('pageerror', onPageErr);

      await startWatching(page);
      const modalsBefore = (await readOpenModals(page)).count;

      // ── 클릭 ──
      let clickFail = null;
      popupSeen = null;
      dialogSeen = null;
      clickInProgress = true;
      clickedAt = Date.now();
      try {
        await locator.click({ timeout: 2500, noWaitAfter: true });
      } catch (e) {
        clickFail = explainClick(e?.message || e, 2500);
      }

      // ── 적응형 관찰: 신호가 잡히면 기다리지 않고 끝낸다 ──
      let mut = null, navigated = false;
      const t0 = Date.now();
      while (true) {
        if (shouldStop()) break;
        const waited = Date.now() - t0;
        if (waited >= OBSERVE_MS) break;
        await page.waitForTimeout(POLL_MS).catch(() => {});
        const m = await readWatch(page);
        if (m === null) { navigated = true; break; }   // 페이지가 넘어감
        mut = m;
        if (waited < MIN_OBSERVE_MS) continue;
        const sig = freshSignals(m, noise);
        if (sig.dom || sig.vis || sig.scroll || popupSeen || dialogSeen || netHits > 0 || page.url() !== urlBefore) {
          await page.waitForTimeout(SETTLE_MS).catch(() => {});
          mut = (await readWatch(page)) || m;
          break;
        }
      }
      const observedMs = Date.now() - t0;
      clickInProgress = false;
      resumeLearning();

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
      const ex = mut ? freshSignals(mut, noise) : { dom: navigated, vis: navigated, scroll: false };
      const signals = {
        dom: ex.dom ? 1 : 0,
        net: netHits > 0 ? 1 : 0,
        url: urlChanged ? 1 : 0,
        console: jsError ? 1 : 0,
        vis: ex.vis ? 1 : 0,
        scroll: ex.scroll ? 1 : 0,
        popup: popupSeen ? 1 : 0,
        dialog: dialogSeen ? 1 : 0,
      };

      // ── 판정 ──
      let status, reason;
      if (jsError) {
        status = 'ERROR'; reason = `JS 예외: ${jsError}`;
      } else if (badStatus) {
        status = 'ERROR'; reason = `HTTP ${badStatus.status} — ${shortUrl(badStatus.url)}`;
      } else if (failedOwn) {
        status = 'ERROR';
        reason = `${failedOwn.why} — ${shortUrl(failedOwn.url)}`;
      } else if (!signals.dom && !signals.net && !signals.url && !signals.vis && !signals.scroll && !signals.popup && !signals.dialog) {
        status = 'NO-RESPONSE'; reason = `클릭 후 ${(observedMs / 1000).toFixed(1)}초 동안 무변화`;
      } else {
        status = 'PASS';
        reason = popupSeen ? `새 창이 열림 — ${shortUrl(popupSeen)}`
          : dialogSeen && !signals.dom && !signals.net && !signals.url
            ? `알림창 표시 — "${dialogSeen.message.slice(0, 60)}"`
            : describe(signals);
      }

      // ── 결함만 스크린샷 ──
      let screenshot = null;
      if (shotDir && (status === 'ERROR' || status === 'NO-RESPONSE')) {
        const file = `${shotTag}-${results.length}-${status}.png`;
        const ok = await page.screenshot({ path: path.join(shotDir, file), timeout: 5000 })
          .then(() => true).catch(() => false);
        if (ok) screenshot = file;
      }

      push({ ...base, status, reason, signals, observedMs, screenshot });

      // ── 페이지를 벗어났으면 원위치 복귀 후 마커 재부여 ──
      if (urlChanged) {
        if (shouldStop()) break;
        pauseLearning();

        // 뒤로가기가 먼저다. 주소를 다시 불러오는 것보다 빠르고 진행 중이던 이동을 덜 끊는다.
        // 돌아왔는지는 주소를 정규화해서 본다 (끝의 / 나 해시 차이로 실패 판정하지 않도록).
        const same = u => String(u).split('#')[0].replace(/\/$/, '');
        let back = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 })
          .then(() => same(page.url()) === same(pageUrl)).catch(() => false);

        // 뒤로가기로 안 되면 주소로 다시 연다.
        // 클릭으로 시작된 이동이 아직 진행 중이면 첫 시도가 "다른 이동이 끼어들었다" 로 막히므로,
        // 잠깐 숨을 돌리고 몇 번 더 시도한다.
        for (let attempt = 0; !back && attempt < 3; attempt++) {
          if (attempt > 0) await page.waitForTimeout(400);
          back = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
            .then(() => true).catch(() => false);
        }

        if (!back) {
          // 정말 못 돌아가면 남은 요소는 검사할 수 없다. 조용히 끝내지 않고 남긴다.
          onElement?.({
            index: i, total,
            result: { page: pageUrl, label: '(검사 중단)', sel: pageUrl, status: 'ERROR',
              reason: `${label} 를 누른 뒤 원래 화면으로 돌아오지 못해 남은 ${total - i - 1}개를 검사하지 못했습니다`,
              signals: {} },
          });
          results.push({ page: pageUrl, label: '(검사 중단)', sel: pageUrl, status: 'ERROR',
            reason: `${label} 를 누른 뒤 원래 화면으로 돌아오지 못해 남은 ${total - i - 1}개를 검사하지 못했습니다`,
            signals: {} });
          break;
        }

        // 되돌아왔다고 바로 요소가 있는 것은 아니다. 화면이 다시 그려질 때까지 기다리지 않으면
        // 남은 요소를 못 찾아 나머지를 통째로 건너뛰게 된다.
        await waitForContent(page);
        await stampElements(page, CLICKABLE);
        resumeLearning();
      } else {
        // ── 클릭으로 모달이 열렸으면 그 안의 요소를 먼저 검사한다 ──
        // 모달은 보통 문서 끝에 있어, 순서대로 가면 모달 밖 요소를 누르느라 닫은 뒤라 영영 못 누른다.
        const opened = await readOpenModals(page);
        if (opened.count > modalsBefore) {
          const later = new Set(queue.slice(qi + 1));
          const first = opened.inside.filter(x => later.has(x));
          if (first.length) {
            const pick = new Set(first);
            const rest = queue.slice(qi + 1).filter(x => !pick.has(x));
            queue.splice(qi + 1, queue.length, ...first, ...rest);
          }
        }
      }
    }
  } catch (e) {
    // 중단 요청으로 브라우저가 닫히면 진행 중이던 작업이 예외를 낸다.
    // 그때까지 모은 결과는 그대로 쓸 수 있으므로 조용히 넘긴다.
    if (!shouldStop()) throw e;
  } finally {
    try { ctx.off('page', onPopup); } catch {}
    try { page.off('dialog', onDialog); } catch {}
    try { bgOff(); } catch {}
  }

  return results;
}

/**
 * 왜 화면에 보이지 않는지 알아낸다.
 * "보이지 않음" 만으로는 다른 탭에 있는 것인지 원래 숨은 것인지 알 수 없어,
 * 그 화면을 따로 검사해야 하는지 판단할 수 없다.
 */
async function whyHidden(locator) {
  const why = await locator.evaluate(node => {
    for (let el = node; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (el.hasAttribute('hidden')) return { kind: 'hidden', tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '' };
      if (cs.display === 'none') return { kind: 'display', tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '' };
      if (cs.visibility === 'hidden') return { kind: 'visibility', tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '' };
      if (Number(cs.opacity) === 0) return { kind: 'opacity', tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '' };
    }
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { kind: 'zero' };
    return { kind: 'other' };
  }).catch(() => ({ kind: 'other' }));

  // 탭 패널·접힌 영역 안에 있으면 다른 화면에 속한 요소다
  if (/tabpanel|tabpane/i.test(why.role || '')) {
    return '다른 탭에 있어 보이지 않음 (그 탭 화면을 따로 검사하세요)';
  }
  switch (why.kind) {
    case 'hidden':
    case 'display': return '접혀 있거나 다른 탭에 있어 보이지 않음';
    case 'visibility': return '숨김 처리되어 보이지 않음';
    case 'opacity': return '투명 처리되어 보이지 않음';
    case 'zero': return '크기가 0이라 보이지 않음';
    default: return '화면에 보이지 않음';
  }
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
  if (s.scroll) hit.push('스크롤');
  if (s.popup) hit.push('새 창');
  if (s.dialog) hit.push('알림창');
  return hit.join(' + ') + ' 변화 감지';
}

module.exports = { scanPage, waitForContent };
