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
const totp = require('./totp');

const SESSION_FILE = path.join(__dirname, '..', 'auth.local.json');
const CRED_FILE = path.join(__dirname, '..', 'credentials.local.json');

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

/** 로그인 상태를 파일로 저장한다 */
function saveSession(state, landedOn) {
  const savedAt = new Date().toISOString();
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ savedAt, url: landedOn, state }, null, 2), 'utf8');
  return { savedAt, file: SESSION_FILE };
}

/** 저장된 로그인을 지운다 */
function clearSession() {
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
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

/* ────────────────── 저장된 계정 정보 ────────────────── */

/**
 * 계정 정보를 이 PC 에 저장한다.
 * 비밀번호와 OTP 비밀키는 저장은 하되 화면으로 되돌려주지 않는다.
 * 이 서버는 사내망에 열려 있을 수 있어, 접속만 하면 값을 볼 수 있으면 안 되기 때문이다.
 */
function saveCredentials(cred) {
  const prev = readCredentials() || {};
  const next = {
    url: cred.url ?? prev.url ?? '',
    username: cred.username ?? prev.username ?? '',
    // 빈 값으로 덮어써 지워지는 일이 없도록, 값이 들어온 항목만 갱신한다
    password: cred.password || prev.password || '',
    otp: cred.otp || prev.otp || '',
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CRED_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function readCredentials() {
  if (!fs.existsSync(CRED_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch { return null; }
}

function clearCredentials() {
  if (fs.existsSync(CRED_FILE)) fs.unlinkSync(CRED_FILE);
}

/** 화면에 보여줘도 되는 정보만 추린다 */
function describeCredentials() {
  const c = readCredentials();
  if (!c) return { exists: false };
  return {
    exists: true,
    url: c.url || '',
    username: c.username || '',
    hasPassword: !!c.password,
    hasOtp: !!c.otp,
    savedAt: c.savedAt || null,
  };
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

/** 화면에 보이는 OTP 입력칸을 찾아 선택자를 붙여 반환한다 (없으면 null) */
async function markOtpField(page) {
  return page.evaluate(() => {
    const hit = [...document.querySelectorAll('input')].find(el => {
      if (!(el.offsetWidth || el.offsetHeight)) return false;
      if (el.value) return false;                       // 이미 채워진 칸은 건너뛴다
      const hint = ((el.placeholder || '') + ' ' + (el.name || '') + ' ' + (el.id || '') + ' ' +
                    (el.getAttribute('autocomplete') || '')).toLowerCase();
      return /otp|one-?time|2fa|mfa|인증번호|인증코드|보안코드/.test(hint);
    });
    if (!hit) return null;
    hit.setAttribute('data-er-otp', '1');
    return "input[data-er-otp='1']";
  }).catch(() => null);
}

/**
 * OTP 칸이 있으면 비밀키로 코드를 만들어 채운다.
 * 코드가 곧 만료될 참이면 다음 코드가 나올 때까지 기다린 뒤 채운다.
 */
async function fillOtp(page, otpValue, log) {
  const sel = await markOtpField(page);
  if (!sel) return false;
  if (!otpValue) throw new Error('OTP_REQUIRED');

  const { code, kind } = totp.resolveCode(otpValue);

  if (kind === 'generated') {
    // 코드가 곧 바뀔 참이면 다음 코드가 나올 때까지 기다린다
    const left = totp.secondsLeft(otpValue);
    if (left < 5) {
      log?.(`OTP 코드가 ${left}초 뒤 바뀝니다. 다음 코드를 기다립니다…`);
      await page.waitForTimeout((left + 1) * 1000);
      await page.fill(sel, totp.generate(otpValue));
      log?.('OTP 코드를 만들어 입력했습니다.');
      return true;
    }
  }

  await page.fill(sel, code);
  await page.waitForTimeout(200);   // OTP 입력으로 버튼이 풀리기까지의 틈
  log?.(kind === 'fixed' ? 'OTP 코드를 입력했습니다.' : 'OTP 코드를 만들어 입력했습니다.');
  return true;
}

/**
 * 로그인이 끝났는지 기다린다.
 *
 * 제출 직후에는 아직 요청이 시작되지도 않았을 수 있다. 그 시점에 화면을 보고 판정하면
 * 멀쩡히 성공하는 로그인도 실패로 단정하게 되므로, 로그인 화면을 벗어날 때까지 지켜본다.
 */
async function waitLoggedIn(page, successIndicator, timeoutMs = 15000) {
  const t0 = Date.now();
  let lastMessage = '';
  while (Date.now() - t0 < timeoutMs) {
    if (successIndicator) {
      if (await page.locator(successIndicator).first().count().catch(() => 0)) return { ok: true };
    } else {
      const onLoginScreen = await page.locator("input[type='password']").first().isVisible().catch(() => false);
      if (!onLoginScreen) return { ok: true };
    }
    // 화면에 뜬 실패 메시지를 잡아두면 원인을 그대로 전달할 수 있다
    const msg = await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(e =>
        e.children.length === 0 && /올바르지 않|실패|확인해|잘못|틀렸/.test(e.textContent || ''));
      return el ? el.textContent.trim().slice(0, 120) : '';
    }).catch(() => '');
    if (msg) lastMessage = msg;
    await page.waitForTimeout(400);
  }
  return { ok: false, message: lastMessage };
}

/**
 * 로그인 제출.
 *
 * 아이디·비밀번호·OTP 를 다 채워야 로그인 버튼이 풀리는 화면이 많다. 화면이 입력을
 * 반영해 버튼을 활성화하기까지는 잠깐 걸리므로, 채우자마자 누르면 비활성 버튼을 누르게 된다.
 * 버튼이 풀릴 때까지 기다렸다가 누르고, 그래도 못 누르면 조용히 넘기지 않고 알린다.
 */
async function submitLogin(page, submitSelector, fallbackField, { required = true, log } = {}) {
  const submit = await firstVisible(page, [
    submitSelector,
    "button[type='submit']", "input[type='submit']",
    "button.loginBtn", "[class*='login' i][type='button']",
  ]);

  if (!submit) {
    log?.('로그인 버튼을 찾지 못해 Enter 로 제출합니다');
    if (fallbackField) await fallbackField.press('Enter').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    return;
  }

  // 버튼이 풀릴 때까지 기다린다
  const enabled = await submit.isEnabled().catch(() => true);
  log?.(enabled ? '로그인 버튼이 눌리는 상태입니다' : '로그인 버튼이 잠겨 있어 풀릴 때까지 기다립니다');
  if (!enabled) {
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll("button, input[type='submit']")]
        .find(x => (x.offsetWidth || x.offsetHeight) &&
          /login|로그인|확인|submit/i.test((x.className || '') + (x.innerText || '') + (x.value || '')));
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    }, null, { timeout: 6000 }).catch(() => {});
  }

  const still = await submit.isDisabled().catch(() => false);
  if (still && required) {
    throw new Error(
      '로그인 버튼이 눌리지 않는 상태입니다. 아이디·비밀번호·OTP 가 모두 채워져야 ' +
      '버튼이 풀리는 화면일 수 있습니다. OTP 칸에 넣을 값을 지정했는지 확인하세요.');
  }

  log?.('로그인 버튼을 누릅니다');
  await submit.click({ timeout: 8000 }).catch(async () => {
    log?.('버튼 클릭이 되지 않아 Enter 로 다시 시도합니다');
    await fallbackField?.press('Enter').catch(() => {});
  });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
}

/**
 * 아이디·비밀번호(필요하면 OTP)를 채워 로그인한다.
 *
 * @param {string} cfg.otp OTP 칸에 넣을 값. 숫자만 있으면 그대로 입력하고(개발 서버의 고정 코드),
 *                         인증 앱 비밀키면 지금 시각의 코드를 만들어 입력한다.
 * @param {function} cfg.onLog 진행 상황 알림
 */
async function doLogin(page, cfg) {
  const { url, username, password, submitSelector, successIndicator } = cfg;
  const otpValue = cfg.otp || cfg.totpSecret;   // 고정 코드 또는 인증 앱 비밀키
  const log = cfg.onLog;
  if (!url) throw new Error('로그인 주소가 비어 있습니다.');

  log?.(`로그인 화면 여는 중 — ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  log?.(`로그인 화면 도착 — ${page.url()}`);

  const pw = await firstVisible(page, [cfg.passwordSelector, "input[type='password']"]);
  if (!pw) throw new Error('로그인 화면에서 비밀번호 입력칸을 찾지 못했습니다. 로그인 주소가 맞는지 확인하세요.');

  // 비밀번호 칸을 기준으로 그 앞의 보이는 텍스트 입력칸을 아이디로 본다.
  // name·id 가 없고 form 태그조차 없는 로그인 화면이 흔하기 때문이다.
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
  await page.waitForTimeout(150);   // 화면이 입력을 반영할 틈
  log?.(`아이디 "${username}" 와 비밀번호를 입력했습니다`);

  // 같은 화면에 OTP 칸이 함께 있는 경우 (아이디·비밀번호·OTP 한 번에 입력하는 방식)
  try {
    await fillOtp(page, otpValue, log);
  } catch (e) {
    if (e.message === 'OTP_REQUIRED') throw new Error(otpGuide());
    throw e;
  }

  await submitLogin(page, submitSelector, pw, { log });
  await page.waitForTimeout(600);   // 제출 직후에는 아직 화면이 그대로일 수 있다
  log?.(`제출 후 주소 — ${page.url()}`);

  // 제출 후 OTP 칸이 나타나는 경우 (2단계로 나뉜 방식)
  try {
    if (await fillOtp(page, otpValue, log)) {
      await submitLogin(page, submitSelector, null, { required: false });
    }
  } catch (e) {
    if (e.message === 'OTP_REQUIRED') throw new Error(otpGuide());
    throw e;
  }

  // 성공 확인 — 제출 결과가 화면에 반영될 때까지 지켜본다
  const done = await waitLoggedIn(page, successIndicator);
  if (!done.ok) {
    if (cfg.shotDir) {
      const file = require('path').join(cfg.shotDir, 'login-failed.png');
      await page.screenshot({ path: file, timeout: 5000 }).catch(() => {});
      log?.('로그인 실패 시점 화면을 저장했습니다 (리포트 폴더의 shots/login-failed.png)');
    }
    if (done.message) throw new Error(`로그인에 실패했습니다: ${done.message}`);
    throw new Error(otpValue
      ? '로그인에 실패했습니다. 아이디·비밀번호와 OTP 값을 확인하세요.'
      : '로그인에 실패했습니다. 아이디·비밀번호를 확인하세요.');
  }

  // 화면이 바뀌었다고 로그인이 끝난 것은 아니다. 요즘 화면은 로그인 응답을 받은 뒤
  // 토큰을 브라우저에 저장하는데, 그 전에 다음 주소로 넘어가면 로그인이 풀린 것으로 처리된다.
  // 저장이 끝날 틈을 주고, 실제로 무언가 저장됐는지 확인한다.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const kept = await page.evaluate(() => {
    const ls = (() => { try { return Object.keys(localStorage).length; } catch { return 0; } })();
    const ss = (() => { try { return Object.keys(sessionStorage).length; } catch { return 0; } })();
    return { ls, ss, cookie: document.cookie.length };
  }).catch(() => ({ ls: 0, ss: 0, cookie: 0 }));

  log?.(`로그인 상태 확인 — 쿠키 ${kept.cookie ? '있음' : '없음'} · 저장소 항목 ${kept.ls + kept.ss}개`);
}

function otpGuide() {
  return '이 화면은 OTP 입력을 요구합니다. OTP 칸에 넣을 값을 알려주세요. ' +
    '개발 서버에서 통하는 고정 코드가 있으면 그 값을, 인증 앱을 쓴다면 앱의 비밀키를 넣으면 됩니다. ' +
    '문자·이메일로 받는 방식이라면 "직접 로그인"으로 한 번 로그인해 상태를 저장하세요.';
}

module.exports = {
  doLogin, captureSession, markOtpField, detectSecondFactor,
  readSession, saveSession, clearSession, hasSession, sessionPath,
  saveCredentials, readCredentials, clearCredentials, describeCredentials,
};
