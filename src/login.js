/**
 * 로그인 세션 처리
 */
async function doLogin(page, loginCfg) {
  const { url, usernameSelector, passwordSelector, submitSelector, username, password, successIndicator } = loginCfg;

  console.log(`  로그인 시도: ${url}`);
  await page.goto(url, { waitUntil: 'load', timeout: 15000 });

  // 2FA 감지 (OTP·인증코드 입력 필드가 있으면 수동 개입 안내)
  const has2FA = await page.$('input[autocomplete="one-time-code"], input[name*="otp"], input[name*="2fa"]');
  if (has2FA) {
    console.error('  2FA 감지 — 수동으로 인증을 완료한 뒤 세션 쿠키를 사용하세요.');
    throw new Error('2FA 수동 개입 필요');
  }

  const userInput = await page.$(usernameSelector);
  const pwInput = await page.$(passwordSelector);
  if (!userInput || !pwInput) {
    throw new Error(`로그인 폼을 찾을 수 없습니다. selector를 config.json에서 확인하세요.`);
  }

  await userInput.fill(username);
  await pwInput.fill(password);

  const submitBtn = await page.$(submitSelector);
  if (!submitBtn) throw new Error('로그인 버튼을 찾을 수 없습니다.');
  await submitBtn.click();
  await page.waitForLoadState('load', { timeout: 10000 });

  // 로그인 성공 여부 확인
  if (successIndicator) {
    const ok = await page.$(successIndicator).catch(() => null);
    if (!ok) throw new Error('로그인 실패 — successIndicator 요소를 찾지 못했습니다.');
  } else {
    // 여전히 로그인 폼이 있으면 실패로 간주
    const stillLogin = await page.$(passwordSelector).catch(() => null);
    if (stillLogin) throw new Error('로그인 실패 — 아이디/비밀번호를 확인하세요.');
  }

  console.log('  로그인 성공');
}

module.exports = { doLogin };
