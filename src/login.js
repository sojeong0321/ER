/**
 * 로그인 처리
 *
 * 두 가지 방식을 지원한다.
 *
 *  1) 저장된 세션 (권장)
 *     `npm run login <주소>` 로 브라우저를 띄워 사람이 직접 로그인한 뒤 그 상태를 파일로 저장한다.
 *     OTP·SSO 처럼 사람이 개입해야 하는 인증도 이 방식이면 통과할 수 있고,
 *     검사할 때마다 계정 정보를 넣지 않아도 된다.
 *
 *  2) 자동 로그인
 *     아이디·비밀번호를 폼에 채워 넣는다. 2단계 인증이 없는 화면에서만 쓸 수 있다.
 */
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '..', 'auth.local.json');

/* ────────────────── 저장된 세션 ────────────────── */

function sessionPath() { return SESSION_FILE; }
function hasSession() { return fs.existsSync(SESSION_FILE); }

/** 저장된 세션 정보를 읽는다 (없으면 null) */
function readSession() {
  if (!hasSession()) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return { state: raw.state ?? raw, savedAt: raw.savedAt || null, url: raw.url || null };
  } catch { return null; }
}

/**
 * 브라우저를 화면에 띄워 사람이 직접 로그인하게 하고, 끝난 상태를 저장한다.
 * @param {string} loginUrl 로그인 화면 주소
 * @param {function} waitForUser 사용자가 "다 됐다"고 알릴 때까지 기다리는 함수
 */
async function captureSession(loginUrl, waitForUser, opts = {}) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    ignoreHTTPSErrors: opts.ignoreHTTPSErrors !== false,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await waitForUser(page);

  const state = await context.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify({
    savedAt: new Date().toISOString(),
    url: page.url(),
    state,
  }, null, 2), 'utf8');

  const summary = {
    file: SESSION_FILE,
    cookies: state.cookies.length,
    origins: state.origins.length,
    landedOn: page.url(),
  };
  await browser.close();
  return summary;
}

/* ────────────────── 자동 로그인 ────────────────── */

async function firstVisible(page, selectors) {
  for (const sel of selectors.filter(Boolean)) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0) && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

/** 사람이 입력해야만 통과되는 인증 단계가 있는지 본다 */
async function detectSecondFactor(page) {
  return page.evaluate(() => {
    const hit = [...document.querySelectorAll('input')].find(el => {
      if (!(el.offsetWidth || el.offsetHeight)) return false;
      const hint = ((el.placeholder || '') + ' ' + (el.name || '') + ' ' + (el.id || '') + ' ' +
                    (el.getAttribute('autocomplete') || '')).toLowerCase();
      return /otp|one-?time|2fa|mfa|인증번호|인증코드|보안코드/.test(hint);
    });
    return hit ? (hit.placeholder || hit.name || hit.id || 'OTP') : null;
  }).catch(() => null);
}

async function doLogin(page, cfg) {
  const { url, username, password, submitSelector, successIndicator } = cfg;
  if (!url) throw new Error('로그인 주소가 비어 있습니다.');

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

  const second = await detectSecondFactor(page);
  if (second) {
    throw new Error(
      `이 화면은 2단계 인증('${second}')을 요구합니다. 아이디·비밀번호만으로는 로그인할 수 없습니다. ` +
      `터미널에서 "npm run login ${url}" 을 실행해 직접 한 번 로그인한 뒤, 저장된 로그인 상태로 검사하세요.`);
  }

  const pw = await firstVisible(page, [cfg.passwordSelector, "input[type='password']"]);
  if (!pw) throw new Error('로그인 화면에서 비밀번호 입력칸을 찾지 못했습니다. 로그인 주소가 맞는지 확인하세요.');

  // 비밀번호 칸을 기준으로 그 앞의 보이는 텍스트 입력칸을 아이디로 본다 (name·id 가 없는 폼이 흔하다)
  const userSel = await page.evaluate(() => {
    const pwEl = [...document.querySelectorAll("input[type='password']")].find(el => el.offsetWidth || el.offsetHeight);
    if (!pwEl) return null;
    const ok = el => {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (!['text', 'email', 'tel', ''].includes(t)) return false;
      if (!(el.offsetWidth || el.offsetHeight)) return false;
      const hint = ((el.placeholder || '') + (el.name || '') + (el.id || '') + (el.getAttribute('autocomplete') || '')).toLowerCase();
      return !/otp|one-?time|인증|코드|captcha|보안문자/.test(hint);
    };
    const all = [...document.querySelectorAll('input')].filter(ok);
    const before = all.filter(el => pwEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
    const target = before.pop() || all[0];
    if (!target) return null;
    target.setAttribute('data-er-user', '1');
    return "input[data-er-user='1']";
  });
  if (!userSel) throw new Error('로그인 화면에서 아이디 입력칸을 찾지 못했습니다.');

  await page.fill(userSel, username);
  await pw.fill(password);

  const submit = await firstVisible(page, [
    submitSelector,
    "button[type='submit']", "input[type='submit']",
    "button.loginBtn", "[class*='login' i][role='button']",
  ]);
  if (submit) {
    await submit.click();
  } else {
    // 제출 버튼을 못 찾으면 비밀번호 칸에서 Enter 로 제출을 시도한다
    await pw.press('Enter');
  }
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});

  if (successIndicator) {
    const ok = await page.locator(successIndicator).first().count().catch(() => 0);
    if (!ok) throw new Error('로그인에 실패했습니다. 성공 확인 요소를 찾지 못했습니다.');
  } else {
    const stillThere = await page.locator("input[type='password']").first().isVisible().catch(() => false);
    if (stillThere) throw new Error('로그인에 실패했습니다. 아이디·비밀번호를 확인하세요.');
  }
}

module.exports = { doLogin, captureSession, readSession, hasSession, sessionPath, detectSecondFactor };
