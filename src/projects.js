/**
 * 프로젝트 — 검사 대상 하나에 필요한 것을 한데 묶는다.
 *
 *   주소 목록 · 로그인(계정 또는 저장된 세션) · 검사 규칙
 *
 * 전역에 하나씩만 저장하던 시절에는 A 시스템의 계정을 저장하면 B 시스템의 계정이 덮어써졌고,
 * 제외 단어도 사이트마다 매번 바꿔야 했다. 프로젝트로 나눠 각자 따로 둔다.
 *
 * 저장 위치 (모두 git 에 올라가지 않는다 — 계정 정보가 들어 있다)
 *   data/projects.json            프로젝트 목록
 *   data/sessions/<id>.json       "직접 로그인" 으로 저장한 세션
 *
 * 비밀번호·OTP 는 저장하되 화면으로 되돌려주지 않는다. publicView() 를 거친 것만 내보낸다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'projects.json');
const SESS_DIR = path.join(DATA_DIR, 'sessions');

/** 프로젝트 없이 주소만 넣고 돌리는 검사. 지울 수 없다. */
const QUICK_ID = 'quick';

const AUTH_MODES = ['none', 'credentials', 'session'];
const SCOPES = ['page', 'path', 'domain'];

/* ────────────────── 기본값 ────────────────── */

function defaultRules() {
  const base = require('../config.json');
  return {
    scope: base.scope || 'path',
    observeMs: base.observeMs || 2000,
    maxPages: base.maxPages || 50,
    excludeRules: [...(base.excludeRules || [])],
    clickNewTab: false,
    clickExternal: false,
    ignoreHTTPSErrors: base.ignoreHTTPSErrors !== false,
  };
}

function emptyAuth() {
  return { mode: 'none', url: '', username: '', password: '', otp: '' };
}

function newId() {
  return crypto.randomUUID().slice(0, 8);
}

/* ────────────────── 읽기·쓰기 ────────────────── */

function readAll() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return null;   // 파일이 없다 — 처음 실행이거나 이관 전
  }
}

function writeAll(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);   // 쓰다 끊겨도 파일이 반쯤 망가지지 않도록
}

/** 목록을 읽는다. 처음이면 기존 설정을 옮겨 담아 만든다. */
function load() {
  let list = readAll();
  if (!list) {
    list = migrate();
    writeAll(list);
  }
  // 빠른 검사는 항상 있어야 한다
  if (!list.some(p => p.id === QUICK_ID)) {
    list.unshift(makeProject({ id: QUICK_ID, name: '빠른 검사' }));
    writeAll(list);
  }
  return list;
}

function makeProject({ id, name, urls, rules, auth } = {}) {
  const now = new Date().toISOString();
  return {
    id: id || newId(),
    name: String(name || '새 프로젝트').trim().slice(0, 60),
    urls: Array.isArray(urls) ? urls : [],
    rules: { ...defaultRules(), ...(rules || {}) },
    auth: { ...emptyAuth(), ...(auth || {}) },
    createdAt: now,
    updatedAt: now,
  };
}

/* ────────────────── 이관 ────────────────── */

/**
 * 프로젝트가 생기기 전에 쓰던 파일들을 옮겨 담는다. 처음 한 번만 돈다.
 *   config.local.json       → 빠른 검사의 규칙
 *   credentials.local.json  → 로그인 주소의 호스트 이름으로 프로젝트 하나
 *   auth.local.json         → 같은 방식 (같은 호스트면 같은 프로젝트에 합친다)
 * 옮긴 원본은 .migrated 를 붙여 남겨 둔다. 되돌려야 할 때를 위해서다.
 */
function migrate() {
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { return null; } };
  const retire = f => { try { fs.renameSync(path.join(ROOT, f), path.join(ROOT, f + '.migrated')); } catch {} };
  const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };

  const localCfg = read('config.local.json');
  const quickRules = { ...defaultRules() };
  if (localCfg) {
    for (const k of Object.keys(quickRules)) if (k in localCfg) quickRules[k] = localCfg[k];
    retire('config.local.json');
  }
  const list = [makeProject({ id: QUICK_ID, name: '빠른 검사', rules: quickRules })];

  const byHost = new Map();
  const cred = read('credentials.local.json');
  if (cred && cred.url) {
    const host = hostOf(cred.url);
    const p = makeProject({
      name: host || '이관된 프로젝트',
      urls: [{ id: newId(), label: '로그인 주소', url: cred.url }],
      rules: quickRules,
      auth: { mode: 'credentials', url: cred.url, username: cred.username || '', password: cred.password || '', otp: cred.otp || '' },
    });
    list.push(p);
    byHost.set(host, p);
    retire('credentials.local.json');
  }

  const sess = read('auth.local.json');
  if (sess) {
    const url = sess.url || '';
    const host = hostOf(url);
    let p = byHost.get(host);
    if (!p) {
      p = makeProject({
        name: host || '이관된 세션',
        urls: url ? [{ id: newId(), label: '저장된 화면', url }] : [],
        rules: quickRules,
        auth: { mode: 'session', url },
      });
      list.push(p);
    }
    fs.mkdirSync(SESS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SESS_DIR, p.id + '.json'),
      JSON.stringify({ savedAt: sess.savedAt || new Date().toISOString(), url, state: sess.state || sess }, null, 2), 'utf8');
    retire('auth.local.json');
  }

  return list;
}

/* ────────────────── 조회 ────────────────── */

function list() { return load(); }

function get(id) {
  return load().find(p => p.id === (id || QUICK_ID)) || null;
}

/** 화면에 내보내도 되는 것만 남긴다. 비밀번호·OTP 값은 있음/없음만 알린다. */
function publicView(p) {
  if (!p) return null;
  const s = readSession(p.id);
  const { password, otp, ...auth } = p.auth || {};
  return {
    id: p.id,
    name: p.name,
    quick: p.id === QUICK_ID,
    urls: p.urls,
    rules: p.rules,
    auth: { ...auth, hasPassword: !!password, hasOtp: !!otp },
    session: s ? { exists: true, savedAt: s.savedAt, url: s.url } : { exists: false },
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/* ────────────────── 변경 ────────────────── */

function create({ name, copyFrom } = {}) {
  const all = load();
  const src = all.find(p => p.id === (copyFrom || QUICK_ID));
  const p = makeProject({ name, rules: src ? { ...src.rules } : undefined });
  all.push(p);
  writeAll(all);
  return p;
}

/**
 * 고친다. 들어온 항목만 바꾼다.
 * 비밀번호·OTP 는 빈 값이 들어오면 기존 값을 유지한다 — 화면은 저장된 값을 모르므로
 * 비워서 보내는 것이 "그대로 두라" 는 뜻이다. 지우려면 clearPassword/clearOtp 를 보낸다.
 */
function update(id, patch = {}) {
  const all = load();
  const p = all.find(x => x.id === id);
  if (!p) throw new Error('프로젝트를 찾을 수 없습니다.');

  if (typeof patch.name === 'string' && patch.name.trim() && id !== QUICK_ID) {
    p.name = patch.name.trim().slice(0, 60);
  }

  if (Array.isArray(patch.urls)) {
    p.urls = patch.urls
      .map(u => ({ id: u.id || newId(), label: String(u.label || '').trim().slice(0, 40), url: String(u.url || '').trim() }))
      .filter(u => /^https?:\/\//i.test(u.url))
      .slice(0, 50);
  }

  if (patch.rules && typeof patch.rules === 'object') {
    const r = patch.rules, next = { ...p.rules };
    const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
    if ('observeMs' in r) { const n = num(r.observeMs, 300, 60000); if (n === null) throw new Error('관찰 시간은 300~60000ms 사이여야 합니다.'); next.observeMs = n; }
    if ('maxPages' in r) { const n = num(r.maxPages, 1, 1000); if (n === null) throw new Error('최대 페이지 수는 1~1000 사이여야 합니다.'); next.maxPages = n; }
    if ('scope' in r && SCOPES.includes(r.scope)) next.scope = r.scope;
    if (Array.isArray(r.excludeRules)) {
      next.excludeRules = [...new Set(r.excludeRules.map(x => String(x).trim()).filter(Boolean))].slice(0, 100);
    }
    for (const k of ['clickNewTab', 'clickExternal', 'ignoreHTTPSErrors']) if (k in r) next[k] = !!r[k];
    p.rules = next;
  }

  if (patch.auth && typeof patch.auth === 'object') {
    const a = patch.auth, next = { ...p.auth };
    if ('mode' in a && AUTH_MODES.includes(a.mode)) next.mode = a.mode;
    if ('url' in a) next.url = String(a.url || '').trim();
    if ('username' in a) next.username = String(a.username || '').trim();
    if (a.password) next.password = String(a.password);
    if (a.otp) next.otp = String(a.otp).trim();
    if (a.clearPassword) next.password = '';
    if (a.clearOtp) next.otp = '';
    p.auth = next;
  }

  p.updatedAt = new Date().toISOString();
  writeAll(all);
  return p;
}

function remove(id) {
  if (id === QUICK_ID) throw new Error('빠른 검사는 지울 수 없습니다.');
  const all = load();
  const i = all.findIndex(p => p.id === id);
  if (i < 0) throw new Error('프로젝트를 찾을 수 없습니다.');
  all.splice(i, 1);
  writeAll(all);
  clearSession(id);
}

/* ────────────────── 세션 ────────────────── */

function sessionFile(id) {
  // 아이디는 우리가 만든 8자리지만, 경로 조작을 막기 위해 한 번 더 거른다
  return path.join(SESS_DIR, String(id).replace(/[^\w-]/g, '') + '.json');
}

function readSession(id) {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
    return { state: raw.state ?? raw, savedAt: raw.savedAt || null, url: raw.url || null };
  } catch { return null; }
}

function saveSession(id, state, url) {
  fs.mkdirSync(SESS_DIR, { recursive: true });
  const savedAt = new Date().toISOString();
  fs.writeFileSync(sessionFile(id), JSON.stringify({ savedAt, url, state }, null, 2), 'utf8');
  return { savedAt };
}

function clearSession(id) {
  try { fs.unlinkSync(sessionFile(id)); } catch {}
}

module.exports = {
  QUICK_ID, list, get, publicView, create, update, remove,
  readSession, saveSession, clearSession, defaultRules,
};
