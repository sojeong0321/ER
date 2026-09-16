/**
 * TOTP 코드 생성 (RFC 6238)
 *
 * Google Authenticator·MS Authenticator 같은 앱이 6자리 코드를 만들어내는 원리는
 * "비밀키 + 현재 시각"을 해시하는 것이다. 비밀키를 알면 같은 코드를 만들 수 있으므로,
 * 앱 방식 OTP는 자동 입력이 가능하다. (문자·이메일로 오는 OTP는 불가능하다)
 *
 * 비밀키는 OTP 등록 화면의 QR 코드 아래 나오는 영문·숫자 문자열이다.
 * otpauth://totp/... 형태의 전체 URL 을 넣어도 키만 뽑아 쓴다.
 */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 문자열을 바이트로 디코드한다 */
function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('OTP 비밀키 형식이 올바르지 않습니다. A~Z와 2~7로 이루어진 문자열이어야 합니다.');

  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * otpauth:// URL 이나 공백이 섞인 입력에서 비밀키와 설정을 뽑아낸다.
 * OTP 등록 화면의 값을 그대로 붙여넣어도 동작하게 하기 위함이다.
 */
function parseSecret(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('OTP 비밀키가 비어 있습니다.');

  if (/^otpauth:\/\//i.test(text)) {
    const u = new URL(text);
    const secret = u.searchParams.get('secret');
    if (!secret) throw new Error('otpauth 주소에 secret 값이 없습니다.');
    return {
      secret,
      digits: Number(u.searchParams.get('digits')) || 6,
      period: Number(u.searchParams.get('period')) || 30,
      algorithm: (u.searchParams.get('algorithm') || 'SHA1').toLowerCase().replace('-', ''),
    };
  }
  return { secret: text, digits: 6, period: 30, algorithm: 'sha1' };
}

/**
 * 현재 시각 기준 OTP 코드를 만든다.
 * @param {string} rawSecret Base32 비밀키 또는 otpauth:// 주소
 * @param {number} [atMs] 기준 시각 (기본값 현재)
 */
function generate(rawSecret, atMs = Date.now()) {
  const { secret, digits, period, algorithm } = parseSecret(rawSecret);
  const key = base32Decode(secret);

  const counter = Math.floor(atMs / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac(algorithm, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 |
                hmac[offset + 2] << 8 | hmac[offset + 3]) % 10 ** digits;

  return String(code).padStart(digits, '0');
}

/** 현재 코드가 앞으로 몇 초 더 유효한지 */
function secondsLeft(rawSecret, atMs = Date.now()) {
  const { period } = parseSecret(rawSecret);
  return period - Math.floor(atMs / 1000) % period;
}

/** 비밀키가 쓸 수 있는 형식인지 확인한다 */
function validate(rawSecret) {
  try { generate(rawSecret); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/**
 * 입력값을 실제 입력할 OTP 코드로 바꾼다.
 *
 * 개발 서버는 '123123' 같은 고정값을 통과시키는 경우가 많다. 그런 값은 그대로 쓰고,
 * 인증 앱의 비밀키(Base32 또는 otpauth:// 주소)가 들어오면 지금 시각의 코드를 만든다.
 *
 * @returns {{code:string, kind:'fixed'|'generated'}}
 */
function resolveCode(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('OTP 값이 비어 있습니다.');
  // 숫자만 있으면 고정 코드로 본다 (인증 앱 비밀키는 영문이 섞인 Base32 문자열이다)
  if (/^\d+$/.test(text)) return { code: text, kind: 'fixed' };
  return { code: generate(text), kind: 'generated' };
}

/** 입력값이 고정 코드인지 비밀키인지 알려준다 */
function describeInput(input) {
  const text = String(input || '').trim();
  if (!text) return { kind: 'none' };
  if (/^\d+$/.test(text)) return { kind: 'fixed' };
  const v = validate(text);
  return v.ok ? { kind: 'generated' } : { kind: 'invalid', error: v.error };
}

module.exports = { generate, secondsLeft, validate, parseSecret, resolveCode, describeInput };
