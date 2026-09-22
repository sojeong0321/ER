/**
 * 단위 검증 — 브라우저 없이 도는 부분
 *
 *   크롤러 범위 판정 · OTP 코드 · 프로젝트 저장(손상된 파일·입력 검증) · 리포트 · 오류 문구
 *
 * 실행: npm test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// 프로젝트 저장소는 모듈을 불러올 때 위치가 정해진다. 실제 data/ 를 건드리지 않도록 먼저 바꿔 둔다.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'er-unit-'));
process.env.ER_DATA_DIR = DATA_DIR;

const XLSX = require('xlsx');
const { normalize, inScope } = require('../src/crawler');
const totp = require('../src/totp');
const projects = require('../src/projects');
const { buildHtml, buildMarkdown, buildExcel } = require('../src/reporter');
const { explainClick, explainNavigation } = require('../src/explain');

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
let total = 0, failed = 0;
function check(ok, msg, detail = '') {
  total++;
  if (!ok) failed++;
  console.log(`  ${ok ? `${C.g}✓` : `${C.r}✗`}${C.x} ${msg}${!ok && detail ? `  ${C.d}${detail}${C.x}` : ''}`);
}
function throws(fn) { try { fn(); return false; } catch { return true; } }
const section = t => console.log(`\n  ${C.b}${t}${C.x}`);

console.log(`\n  ${C.b}ER 단위 검증${C.x}`);

section('크롤러 범위');
check(normalize('https://a.com/x/?utm_source=m&id=3#top') === 'https://a.com/x?id=3', '해시·추적 파라미터·끝의 / 를 없앤다',
  normalize('https://a.com/x/?utm_source=m&id=3#top'));
check(inScope('https://a.com/admin/users', 'https://a.com/admin/orders', 'path'), '같은 폴더의 다른 화면은 하위 경로 범위 안');
check(!inScope('https://a.com/admin/users', 'https://a.com/administrator/x', 'path'), '/admin 범위가 /administrator 를 포함하지 않는다');
check(inScope('https://a.com/admin/', 'https://a.com/admin', 'path'), '폴더 주소 자체(끝 / 없음)는 범위 안');
check(!inScope('https://a.com/a', 'https://b.com/a', 'domain'), '다른 호스트는 사이트 전체 범위에서도 밖');
check(!inScope('https://a.com/', 'https://a.com:8443/', 'domain'), '포트가 다르면 밖');
check(!inScope('https://a.com/', 'https://a.com/x', 'page'), '이 페이지만 범위는 다른 주소로 가지 않는다');
check(!inScope('https://a.com/', 'mailto:x@a.com', 'domain'), 'http(s) 가 아닌 링크는 밖');

section('OTP (RFC 6238 시험 벡터)');
const RFC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';   // "12345678901234567890"
check(totp.generate(`otpauth://totp/t?secret=${RFC}&digits=8`, 59 * 1000) === '94287082', 'T=59 → 94287082');
check(totp.generate(`otpauth://totp/t?secret=${RFC}&digits=8`, 1111111109 * 1000) === '07081804', 'T=1111111109 → 07081804 (앞자리 0 유지)');
check(totp.generate(RFC, 59 * 1000) === '287082', '기본 6자리');
check(totp.secondsLeft(RFC, 59 * 1000) === 1, '남은 시간 계산');
check(totp.describeInput('123123').kind === 'fixed', '숫자만 있으면 고정 코드');
check(totp.describeInput('JBSW Y3DP EHPK 3PXP').kind === 'generated', '공백 섞인 비밀키도 받아들인다');
check(totp.describeInput('not-a-key!').kind === 'invalid', '잘못된 비밀키는 invalid');
check(totp.describeInput('').kind === 'none', '빈 값은 none');

section('프로젝트 저장');
fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), '{ 이건 JSON 이 아님', 'utf8');
const listed = projects.list();
const backups = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('projects.json.broken-'));
check(listed.some(p => p.id === projects.QUICK_ID), '손상된 파일이어도 빠른 검사로 다시 시작한다');
check(backups.length === 1, '손상된 원본을 지우지 않고 옆에 남긴다', fs.readdirSync(DATA_DIR).join(', '));

const p = projects.create({ name: '  테스트  ' });
check(p.name === '테스트' && p.rules.excludeRules.length > 0, '새 프로젝트는 이름을 다듬고 기본 규칙으로 시작한다');
const u = projects.update(p.id, { urls: [null, 'x', { url: 'ftp://a' }, { label: '홈', url: ' https://a.com ' }] });
check(u.urls.length === 1 && u.urls[0].url === 'https://a.com', '주소 목록에서 잘못된 항목을 거른다', JSON.stringify(u.urls));
check(throws(() => projects.update(p.id, { auth: { url: 'javascript:alert(1)' } })), 'http(s) 가 아닌 로그인 주소는 거부한다');
check(throws(() => projects.update(p.id, { rules: { observeMs: 'abc' } })), '숫자가 아닌 관찰 시간은 거부한다');
check(throws(() => projects.update(p.id, { rules: { maxPages: 0 } })), '범위 밖의 최대 페이지 수는 거부한다');
projects.update(p.id, { auth: { mode: 'credentials', username: 'u', password: 'secret-pw', otp: '123123' } });
const pub = projects.publicView(projects.get(p.id));
check(pub.auth.hasPassword && pub.auth.hasOtp && !('password' in pub.auth) && !('otp' in pub.auth),
  '화면에 내보내는 값에는 비밀번호·OTP 가 없다');
projects.update(p.id, { auth: { password: '' } });
check(projects.get(p.id).auth.password === 'secret-pw', '비밀번호를 비워 보내면 기존 값을 유지한다');
projects.update(p.id, { auth: { clearPassword: true } });
check(projects.get(p.id).auth.password === '', 'clearPassword 로만 지운다');
check(throws(() => projects.remove(projects.QUICK_ID)), '빠른 검사는 지울 수 없다');
projects.saveSession(p.id, { cookies: [], origins: [] }, 'https://a.com');
projects.remove(p.id);
check(!projects.get(p.id) && !projects.readSession(p.id), '프로젝트를 지우면 저장된 로그인도 지운다');
projects.saveSession('../../escape', { cookies: [] }, '');
check(fs.existsSync(path.join(DATA_DIR, 'sessions', 'escape.json')) && !fs.existsSync(path.join(DATA_DIR, '..', 'escape.json')),
  '세션 파일 이름에 ../ 가 있어도 세션 폴더를 벗어나지 않는다');

section('리포트');
const results = [
  { page: 'https://a.com/', label: '<img src=x onerror=alert(1)>', sel: 'button#a', status: 'ERROR', reason: 'JS 예외: x',
    signals: { dom: 1, console: 1 }, observedMs: 900, screenshot: 'abc-0-ERROR.png' },
  { page: 'https://a.com/', label: '저장 | 확인', sel: 'button#b', status: 'PASS', reason: '알림창 표시',
    signals: { dialog: 1 }, observedMs: 500 },
];
const meta = { url: 'https://a.com/', scope: 'path', elapsed: '1.2', scannedAt: '지금', scanId: 's1' };
const html = buildHtml(results, meta);
check(!html.includes('<img src=x') && html.includes('&lt;img src=x'), 'HTML 리포트는 요소 이름을 이스케이프한다');
check(html.includes('href="shots/abc-0-ERROR.png"'), '기본 스크린샷 경로는 리포트 옆 shots/');
check(buildHtml(results, meta, { shotBase: '/reports/s1/shots/' }).includes('href="/reports/s1/shots/abc-0-ERROR.png"'),
  '서버가 보여주는 리포트는 스크린샷을 절대 경로로 건다');
check(html.includes('알림창'), '알림창 신호를 리포트에 표시한다');
check(buildMarkdown(results, meta).includes('저장 \\| 확인'), 'Markdown 표 안의 | 를 이스케이프한다');
const buf = buildExcel(results, meta);
const wb = XLSX.read(buf, { type: 'buffer' });
const rows = XLSX.utils.sheet_to_json(wb.Sheets['상세'], { header: 1 });
check(Buffer.isBuffer(buf) && wb.SheetNames.join() === '요약,상세' && rows.length === 3, '엑셀을 메모리에서 만든다 (요약·상세)');
check(rows[0].includes('알림창') && rows[0].length === rows[1].length, '엑셀 상세에 알림창 열이 있다');

section('오류 문구');
check(explainClick('x\n  - <div class="backdrop big">…</div> intercepts pointer events') === '<div class="backdrop"> 가 위를 덮고 있어 클릭이 닿지 않습니다',
  '가린 요소를 댄다');
check(/인증서/.test(explainNavigation('net::ERR_CERT_AUTHORITY_INVALID at https://a')), '인증서 오류를 풀어 쓴다');
check(/연결을 거부/.test(explainNavigation('page.goto: net::ERR_CONNECTION_REFUSED')), '연결 거부를 풀어 쓴다');

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n  ${'─'.repeat(60)}`);
console.log(failed === 0 ? `  ${C.g}${C.b}통과 ${total}/${total}${C.x}\n` : `  ${C.r}${C.b}실패 ${failed}/${total}${C.x}\n`);
process.exit(failed === 0 ? 0 : 1);
