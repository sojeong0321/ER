/**
 * 판정 엔진 — smoke-engine.js PoC 계승, 모듈화 + Windows 호환
 */
const defaultCfg = require('../config.json');

async function scanPage(page, pageUrl, opts = {}) {
  const OBSERVE_MS = opts.observeMs ?? defaultCfg.observeMs ?? 2000;
  const EXCLUDE_RULES = opts.excludeRules ?? defaultCfg.excludeRules ?? ['삭제', '탈퇴', '결제', '로그아웃'];

  const results = [];
  const handles = await page.$$('button, a, [role=button], [onclick]');

  for (let i = 0; i < handles.length; i++) {
    const els = await page.$$('button, a, [role=button], [onclick]');
    const el = els[i];
    if (!el) continue;

    const label = ((await el.innerText().catch(() => '')) ||
      (await el.getAttribute('aria-label').catch(() => '')) ||
      (await el.getAttribute('id').catch(() => '')) ||
      '(no-label)').trim().replace(/\s+/g, ' ').slice(0, 80);

    const sel = await el.evaluate(node => {
      if (node.id) return node.tagName.toLowerCase() + '#' + node.id;
      const cls = String(node.className || '').trim().split(/\s+/)[0];
      return node.tagName.toLowerCase() + (cls ? '.' + cls : '');
    });

    // EXCLUDED 사전 판정
    const disabled = await el.evaluate(n =>
      n.disabled === true || n.getAttribute('aria-disabled') === 'true'
    );
    if (disabled) {
      results.push({ page: pageUrl, label, sel, status: 'EXCLUDED', reason: 'disabled', signals: {} });
      continue;
    }
    if (EXCLUDE_RULES.some(r => label.includes(r))) {
      results.push({ page: pageUrl, label, sel, status: 'EXCLUDED', reason: `제외규칙: '${EXCLUDE_RULES.find(r => label.includes(r))}'`, signals: {} });
      continue;
    }

    // 뷰포트 밖·숨김 요소 건너뜀
    const visible = await el.isVisible().catch(() => false);
    if (!visible) {
      results.push({ page: pageUrl, label, sel, status: 'EXCLUDED', reason: '비가시 요소', signals: {} });
      continue;
    }

    // 클릭 전 스냅샷
    const before = { html: await page.content(), url: page.url() };
    let netHit = false, jsError = false, badResponse = false;

    const onReq = () => { netHit = true; };
    const onResp = resp => { if (resp.status() >= 400) badResponse = true; };
    const onConsole = msg => {
      if (msg.type() !== 'error') return;
      const txt = msg.text();
      if (/net::ERR|Failed to load resource|ERR_|fetch/i.test(txt)) return;
      jsError = true;
    };
    const onPageErr = () => { jsError = true; };

    page.on('request', onReq);
    page.on('response', onResp);
    page.on('console', onConsole);
    page.on('pageerror', onPageErr);

    let clickable = true;
    let screenshotPath = null;
    try {
      await el.click({ timeout: 1500, noWaitAfter: true });
    } catch {
      clickable = false;
    }

    await page.waitForTimeout(OBSERVE_MS);

    page.off('request', onReq);
    page.off('response', onResp);
    page.off('console', onConsole);
    page.off('pageerror', onPageErr);

    if (!clickable) {
      results.push({ page: pageUrl, label, sel, status: 'UNCLICKABLE', reason: '클릭 불가', signals: {} });
      continue;
    }

    // 클릭 후 스냅샷
    const after = { html: await page.content(), url: page.url() };
    const domChanged = before.html !== after.html;
    const urlChanged = before.url !== after.url;

    const signals = {
      dom: domChanged ? 1 : 0,
      net: netHit ? 1 : 0,
      url: urlChanged ? 1 : 0,
      console: jsError ? 1 : 0,
    };

    let status;
    if (jsError || badResponse) {
      status = 'ERROR';
    } else if (!domChanged && !netHit && !urlChanged) {
      status = 'NO-RESPONSE';
    } else {
      status = 'PASS';
    }

    // URL 변경 시 원위치 복귀
    if (urlChanged) {
      await page.goto(pageUrl, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
    }

    results.push({ page: pageUrl, label, sel, status, signals, screenshotPath });
  }

  return results;
}

module.exports = { scanPage };
