#!/usr/bin/env node
/**
 * 로그인 상태 저장
 *
 * 브라우저를 화면에 띄워 직접 로그인하게 하고, 그 상태를 파일로 저장한다.
 * OTP·SSO 처럼 사람이 개입해야 하는 인증도 이 방식이면 통과할 수 있다.
 * 저장한 뒤에는 검사할 때마다 로그인할 필요가 없다.
 *
 * 사용: npm run login <로그인 주소>
 */
const readline = require('readline');
const { captureSession, sessionPath } = require('./src/login');
const cfg = require('./config.json');

const url = process.argv[2] || cfg.login?.url;
if (!url) {
  console.error(`
  사용법: npm run login <로그인 주소>

  예시:
    npm run login https://dev-admin.example.co.kr/
`);
  process.exit(1);
}

const D = '\x1b[2m', B = '\x1b[1m', G = '\x1b[32m', X = '\x1b[0m';

(async () => {
  console.log(`
  ${B}로그인 상태 저장${X}

  브라우저 창이 곧 열립니다.
  ${B}그 창에서 직접 로그인하세요.${X} OTP 가 있으면 OTP 까지 입력하면 됩니다.
  로그인이 끝나 원하는 화면이 보이면, ${B}이 터미널로 돌아와 Enter${X} 를 누르세요.

  ${D}대상: ${url}${X}
`);

  try {
    const info = await captureSession(url, () => new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('  로그인이 끝났으면 Enter를 누르세요... ', () => { rl.close(); resolve(); });
    }), { ignoreHTTPSErrors: cfg.ignoreHTTPSErrors !== false });

    console.log(`
  ${G}로그인 상태를 저장했습니다.${X}
  ${D}파일      ${info.file}
  쿠키      ${info.cookies}개
  마지막 화면 ${info.landedOn}${X}

  이제 검사할 때 "저장된 로그인 사용"을 켜면 이 상태로 검사합니다.
  세션이 만료되면 이 명령을 다시 실행하세요.
`);
  } catch (e) {
    console.error(`\n  저장하지 못했습니다: ${e.message}\n`);
    process.exit(1);
  }
})();
