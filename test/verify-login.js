/**
 * 로그인 자동화 검증
 *
 * 실제 사내 시스템과 같은 조건(아이디 칸에 name·id 없음, form 태그 없음, OTP 입력칸 존재)에서
 * 자동 로그인이 통과하는지 확인한다.
 *
 * 실행: npm run test:login
 */
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');
const { doLogin } = require('../src/login');
const totp = require('../src/totp');

const PORT = Number(process.env.TEST_PORT) || 3988;
const BASE = `http://127.0.0.1:${PORT}`;
const ACCOUNT = { username: 'tester', password: 'test1234' };
const SECRET = 'JBSWY3DPEHPK3PXP';   // 인증 앱 비밀키
const FIXED = '123123';               // 개발 서버가 통과시키는 고정 코드

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => require('http').get(`${BASE}/api/health`, res => {
      res.resume(); res.statusCode === 200 ? resolve() : retry();
    }).on('error', retry);
    const retry = () => Date.now() - t0 > timeoutMs
      ? reject(new Error('서버가 시작되지 않았습니다.')) : setTimeout(tick, 250);
    tick();
  });
}

const CASES = [
  {
    name: '고정 OTP 코드로 로그인 (개발 서버 방식)',
    cfg: { ...ACCOUNT, otp: FIXED },
    expect: 'success',
  },
  {
    name: '인증 앱 비밀키로 로그인 (코드 자동 생성)',
    cfg: { ...ACCOUNT, otp: SECRET },
    expect: 'success',
  },
  {
    name: '비밀번호가 틀리면 화면의 메시지를 그대로 전한다',
    cfg: { ...ACCOUNT, otp: FIXED, password: 'wrong-password' },
    expect: /아이디 또는 비밀번호가 올바르지 않습니다/,
  },
  {
    name: 'OTP 값이 틀리면 화면의 메시지를 그대로 전한다',
    cfg: { ...ACCOUNT, otp: '999999' },
    expect: /OTP 코드가 올바르지 않습니다/,
  },
  {
    name: 'OTP 값이 없으면 무엇을 넣어야 하는지 안내한다',
    cfg: { ...ACCOUNT },
    expect: /OTP 입력을 요구합니다/,
  },
];

(async () => {
  console.log(`\n  ${C.b}로그인 자동화 검증${C.x}`);
  console.log(`  ${C.d}대상 ${BASE}/test-login.html  (이름 없는 입력칸 · form 없음 · OTP 있음)${C.x}\n`);

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  let browser, failed = 0;
  try {
    await waitForServer();
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

    for (const c of CASES) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      let got;
      try {
        await doLogin(page, { ...c.cfg, url: `${BASE}/test-login.html` });
        got = page.url().includes('test-target') ? 'success' : `로그인 후 이동하지 않음 (${page.url()})`;
      } catch (e) {
        got = e.message;
      }
      await context.close();

      const ok = c.expect === 'success' ? got === 'success' : c.expect.test(got);
      if (!ok) failed++;
      console.log(`  ${ok ? C.g + '✓' + C.x : C.r + '✗' + C.x} ${c.name}`);
      console.log(`     ${C.d}${got === 'success' ? '로그인 성공 후 대상 화면으로 이동' : got.slice(0, 96)}${C.x}`);
    }

    console.log(`\n  ${C.d}참고 — 비밀키로 만든 지금 코드: ${totp.generate(SECRET)} (${totp.secondsLeft(SECRET)}초 남음)${C.x}`);
    console.log(failed === 0
      ? `  ${C.g}${C.b}통과 ${CASES.length}/${CASES.length}${C.x}\n`
      : `  ${C.r}${C.b}실패 ${failed}/${CASES.length}${C.x}\n`);
  } catch (e) {
    console.error(`\n  ${C.r}검증 실행 오류: ${e.message}${C.x}\n`);
    failed = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  process.exit(failed === 0 ? 0 : 1);
})();
