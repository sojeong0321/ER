#!/usr/bin/env node
/**
 * ER — 자동 스모크 테스트 CLI
 *
 * 사용: node scan.js [URL] [옵션]
 *   --project <이름|id>         프로젝트의 규칙·로그인으로 검사 (기본: 빠른 검사)
 *   --scope page|path|domain   검사 범위 (기본: 프로젝트 규칙)
 *   --observe <ms>             요소당 최대 관찰 시간
 *   --max-pages <n>            최대 순회 페이지 수
 *   --exclude "삭제,결제"       제외 규칙 (쉼표 구분)
 *   --login                    config.json 의 로그인 정보 사용
 *   --out <dir>                리포트 저장 경로
 *   --quiet                    요약만 출력
 */
const { chromium } = require('playwright');
const path = require('path');
const { doLogin } = require('./src/login');
const projects = require('./src/projects');
const { crawl } = require('./src/crawler');
const { saveHtml, saveExcel } = require('./src/reporter');
const cfg = require('./config.json');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

function isOptionValue(a) {
  const i = args.indexOf(a);
  return i > 0 && ['--project', '--scope', '--observe', '--max-pages', '--exclude', '--out'].includes(args[i - 1]);
}

if (has('--projects')) {
  console.log('');
  for (const p of projects.list()) {
    const v = projects.publicView(p);
    const auth = { none: '로그인 없음', credentials: `계정 ${v.auth.username || '(비어 있음)'}`, session: `직접 로그인 ${v.session.exists ? '저장됨' : '(저장 안 됨)'}` }[v.auth.mode];
    console.log(`  ${p.id.padEnd(10)} ${p.name}  ·  주소 ${p.urls.length}개  ·  ${auth}`);
  }
  console.log('');
  process.exit(0);
}

const projectKey = val('--project', projects.QUICK_ID);
const project = projects.get(projectKey) || projects.list().find(p => p.name === projectKey);
if (!project) {
  console.error(`\n  프로젝트 "${projectKey}" 를 찾을 수 없습니다. 목록: node scan.js --projects\n`);
  process.exit(1);
}
const rules = project.rules;

// 주소를 생략하면 프로젝트에 등록된 첫 번째 주소를 검사한다
const targetUrl = args.find(a => !a.startsWith('--') && !isOptionValue(a)) || project.urls[0]?.url;

if (!targetUrl || has('--help') || has('-h')) {
  console.log(`
  ER — 자동 스모크 테스트

  사용법:
    node scan.js [URL] [옵션]

  옵션:
    --project <이름|id>         프로젝트의 규칙·로그인으로 검사 (기본: 빠른 검사)
                               주소를 생략하면 프로젝트의 첫 번째 주소를 검사
    --projects                 프로젝트 목록 보기
    --scope page|path|domain   검사 범위 (기본: ${rules.scope})
    --observe <ms>             요소당 최대 관찰 시간 (기본: ${rules.observeMs})
    --max-pages <n>            최대 순회 페이지 수 (기본: ${rules.maxPages})
    --exclude "삭제,결제"       제외 규칙 (기본: ${rules.excludeRules.join(',')})
    --login                    config.json 의 로그인 정보 사용
    --session                  프로젝트에 저장된 직접 로그인 사용 (npm run login 으로 미리 저장)
    --no-login                 프로젝트에 로그인 설정이 있어도 로그인하지 않고 검사
    --click-new-tab            새 탭으로 열리는 링크도 검사 (결제창 등 새 창 확인)
    --click-external           다른 사이트로 나가는 링크도 검사
    --out <dir>                리포트 저장 경로 (기본: ${cfg.outputDir})
    --quiet                    요약만 출력

  예시:
    node scan.js https://example.com
    node scan.js http://localhost:8080 --scope domain --observe 1500
    node scan.js --project "bhc 관리자"
`);
  process.exit(targetUrl ? 0 : 1);
}

// ── 옵션 조립 (이전 버전은 이 옵션들을 crawl 에 넘기지 않아 전부 무시됐다) ──
const scope = val('--scope', rules.scope ?? 'path');
const observeMs = Number(val('--observe', rules.observeMs ?? 2000));
const maxPages = Number(val('--max-pages', rules.maxPages ?? 50));
// 잘못된 값으로 조용히 다르게 검사하지 않도록 시작 전에 멈춘다
const badOption =
  !['page', 'path', 'domain'].includes(scope) ? `--scope 는 page, path, domain 중 하나여야 합니다 (받은 값: ${scope})`
  : !(Number.isInteger(observeMs) && observeMs >= 300 && observeMs <= 60000) ? `--observe 는 300~60000 사이의 정수(ms)여야 합니다 (받은 값: ${val('--observe', '')})`
  : !(Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= 1000) ? `--max-pages 는 1~1000 사이의 정수여야 합니다 (받은 값: ${val('--max-pages', '')})`
  : !/^https?:\/\//i.test(targetUrl) ? `주소는 http:// 또는 https:// 로 시작해야 합니다 (받은 값: ${targetUrl})`
  : null;
if (badOption) {
  console.error(`\n  ${badOption}\n`);
  process.exit(2);
}
const excludeRules = val('--exclude', rules.excludeRules.join(','))
  .split(',').map(s => s.trim()).filter(Boolean);
// 로그인 방식: 명령줄 옵션이 프로젝트 설정보다 우선한다
const noLogin = has('--no-login');
const useSession = !noLogin && (has('--session') || project.auth.mode === 'session');
const useProjectLogin = !noLogin && !useSession && project.auth.mode === 'credentials';
const useLogin = !noLogin && !useSession && !useProjectLogin && (has('--login') || cfg.login?.enabled === true);
const clickNewTab = has('--click-new-tab') || !!rules.clickNewTab;
const clickExternal = has('--click-external') || !!rules.clickExternal;
const outputDir = path.resolve(val('--out', cfg.outputDir ?? 'report'));
const quiet = has('--quiet');

const C = {
  PASS: '\x1b[32m', ERROR: '\x1b[31m', 'NO-RESPONSE': '\x1b[33m',
  EXCLUDED: '\x1b[90m', UNCLICKABLE: '\x1b[90m', reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
};
const color = (s, t) => `${C[s] || ''}${t}${C.reset}`;

(async () => {
  console.log('');
  console.log(`  ${C.bold}ER — 자동 스모크 테스트${C.reset}`);
  console.log(`  ${C.dim}프로젝트 ${project.name}  ·  대상 ${targetUrl}  ·  범위 ${scope}  ·  관찰 ${observeMs}ms${C.reset}`);
  console.log('');

  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (e) {
    const m = String(e?.message || e);
    if (/Executable doesn't exist|Please run the following command/i.test(m)) {
      console.error(`  브라우저(Chromium)가 없습니다. 아래를 먼저 실행하세요.\n\n    npx playwright install chromium\n`);
    } else {
      console.error(`  브라우저를 시작하지 못했습니다: ${m.split('\n')[0]}`);
    }
    process.exit(1);
  }

  let storageState;
  if (useSession) {
    const saved = projects.readSession(project.id);
    if (!saved) {
      const opt = project.id === projects.QUICK_ID ? '' : ` --project "${project.name}"`;
      console.error(`  이 프로젝트에 저장된 로그인이 없습니다. 먼저 실행하세요:\n\n    npm run login -- <로그인 주소>${opt}\n`);
      await browser.close();
      process.exit(1);
    }
    storageState = saved.state;
    console.log(`  ${C.dim}저장된 로그인 사용 (${new Date(saved.savedAt).toLocaleString('ko-KR')} 저장)${C.reset}`);
  }

  const context = await browser.newContext({
    ignoreHTTPSErrors: rules.ignoreHTTPSErrors !== false,
    acceptDownloads: false,
    viewport: { width: 1440, height: 900 },
    ...(storageState ? { storageState } : {}),
  });
  const page = await context.newPage();

  const loginCfg = useProjectLogin
    ? { ...cfg.login, url: project.auth.url, username: project.auth.username, password: project.auth.password, otp: project.auth.otp }
    : useLogin && cfg.login?.username ? cfg.login : null;
  if (loginCfg) {
    try {
      console.log(`  ${C.dim}로그인 중 — ${loginCfg.url} · ${loginCfg.username}${C.reset}`);
      await doLogin(page, loginCfg);
    } catch (e) {
      console.error(`  로그인 실패: ${e.message}`);
      await browser.close();
      process.exit(1);
    }
  }

  const t0 = Date.now();
  let pageNo = 0, scannedPages = 0;

  const results = await crawl(browser, targetUrl, scope, ev => {
    if (ev.type === 'done') scannedPages++;   // 건너뛴 주소는 세지 않는다
    if (quiet) return;
    if (ev.type === 'page') { pageNo++; console.log(`  ${C.dim}[${pageNo}]${C.reset} ${ev.url}`); }
    if (ev.type === 'done') console.log(`      ${C.dim}→ ${ev.count}개 요소 검사 완료${C.reset}`);
    if (ev.type === 'pageError') console.log(`      ${color('ERROR', '접근 실패')} ${ev.msg}`);
    if (ev.type === 'redirected') console.log(`      ${C.dim}주소가 넘겨짐 → ${ev.to}${C.reset}`);
    if (ev.type === 'limit') console.log(`  ${C.dim}최대 페이지 수(${ev.max}) 도달 — ${ev.skipped}개 건너뜀${C.reset}`);
  }, { observeMs, excludeRules, maxPages, clickNewTab, clickExternal, screenshotDir: ensureDir(path.join(outputDir, 'shots')) });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  await browser.close();

  // ── 집계 ──
  const c = { PASS: 0, ERROR: 0, 'NO-RESPONSE': 0, EXCLUDED: 0, UNCLICKABLE: 0 };
  results.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
  const tested = c.PASS + c.ERROR + c['NO-RESPONSE'];
  const rate = tested ? Math.round(c.PASS / tested * 100) : 0;

  // ── 결함 목록 ──
  const defects = results.filter(r => r.status === 'ERROR' || r.status === 'NO-RESPONSE');
  if (defects.length && !quiet) {
    console.log('');
    console.log(`  ${C.bold}발견된 결함 ${defects.length}건${C.reset}`);
    for (const d of defects) {
      console.log(`    ${color(d.status, d.status.padEnd(12))} ${d.label.slice(0, 32).padEnd(34)} ${C.dim}${d.reason || ''}${C.reset}`);
    }
  }

  console.log('');
  console.log(`  총 ${results.length}개 요소 · ${scannedPages}개 페이지 · ${elapsed}s`);
  console.log(`  ${color('PASS', `PASS ${c.PASS}`)}  ${color('ERROR', `ERROR ${c.ERROR}`)}  ${color('NO-RESPONSE', `NO-RESPONSE ${c['NO-RESPONSE']}`)}  ${color('EXCLUDED', `EXCLUDED ${c.EXCLUDED + c.UNCLICKABLE}`)}`);
  console.log(`  Pass율 ${rate}%`);
  console.log('');

  const meta = { url: targetUrl, scope, elapsed, scannedAt: new Date().toLocaleString('ko-KR') };
  const htmlPath = saveHtml(results, meta, outputDir);
  const xlsxPath = saveExcel(results, meta, outputDir);
  console.log(`  리포트  ${C.dim}${htmlPath}${C.reset}`);
  console.log(`          ${C.dim}${xlsxPath}${C.reset}`);
  console.log('');

  // 결함이 있으면 1로 종료 — CI 파이프라인에서 게이트로 쓸 수 있다
  process.exit(defects.length > 0 ? 1 : 0);
})().catch(e => {
  console.error(`\n  오류: ${e?.message || e}\n`);
  process.exit(2);
});

function ensureDir(p) { require('fs').mkdirSync(p, { recursive: true }); return p; }
