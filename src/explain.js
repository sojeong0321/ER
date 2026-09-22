/**
 * Playwright 가 내는 영문 오류를 읽을 수 있는 문장으로 바꾼다.
 *
 * 원문은 "locator.click: Timeout 2500ms exceeded." 처럼 첫 줄만 보면 시간이 지났다는
 * 것밖에 알 수 없고, 진짜 원인(가려짐·움직임·사라짐)은 그 아래 Call log 에 들어 있다.
 * 여기서 전체 메시지를 훑어 원인을 찾아내고, 무엇을 확인하면 되는지까지 적는다.
 */

/** 클릭이 실패한 이유 */
function explainClick(raw, timeoutMs) {
  const m = String(raw || '');
  const sec = timeoutMs ? (timeoutMs / 1000).toFixed(1) : '2.5';

  // 다른 요소가 덮고 있어 클릭이 닿지 않는 경우 — 가장 흔하다
  if (/intercepts pointer events/i.test(m)) {
    // Call log 에는 클릭하려던 요소도 함께 찍힌다. 덮은 요소는 "intercepts" 가 있는 줄의 첫 태그다.
    // 메시지 전체에서 class 를 찾으면 클릭 대상의 class 를 덮은 요소의 것으로 잘못 붙인다.
    const line = m.split('\n').find(l => /intercepts pointer events/i.test(l)) || '';
    const open = line.match(/<(\w+)([^>]*)>/);
    const tag = open?.[1];
    const cls = open?.[2].match(/class="([^"]{1,40})"/)?.[1];
    const who = tag ? `<${tag}${cls ? ` class="${cls.split(' ')[0]}"` : ''}>` : '다른 요소';
    return `${who} 가 위를 덮고 있어 클릭이 닿지 않습니다`;
  }
  if (/element is not stable|is not stable/i.test(m)) {
    return `요소가 계속 움직여서 클릭하지 못했습니다 (애니메이션·스크롤 중일 수 있습니다)`;
  }
  if (/element is not visible|not visible/i.test(m)) {
    return `화면에 보이지 않는 상태라 클릭하지 못했습니다`;
  }
  if (/element is not enabled|not enabled/i.test(m)) {
    return `비활성(disabled) 상태라 클릭하지 못했습니다`;
  }
  if (/outside of the viewport/i.test(m)) {
    return `화면 밖에 있어 클릭하지 못했습니다`;
  }
  if (/not attached to the DOM|Element is not attached/i.test(m)) {
    return `클릭하려는 순간 요소가 화면에서 사라졌습니다`;
  }
  if (/Target (page|closed)|browser has been closed|Target closed/i.test(m)) {
    return `검사가 중단되어 클릭하지 못했습니다`;
  }
  if (/strict mode violation/i.test(m)) {
    return `같은 조건에 해당하는 요소가 여럿이라 하나를 고르지 못했습니다`;
  }
  if (/Timeout .*exceeded/i.test(m)) {
    return `${sec}초 안에 클릭할 수 없었습니다 (가려졌거나 계속 움직이는 요소일 수 있습니다)`;
  }
  return m.split('\n')[0].slice(0, 120);
}

/** 페이지에 들어가지 못한 이유 */
function explainNavigation(raw) {
  const m = String(raw || '');
  const pick = {
    'ERR_CONNECTION_REFUSED': '서버가 연결을 거부했습니다 (서버가 꺼져 있거나 포트가 다를 수 있습니다)',
    'ERR_NAME_NOT_RESOLVED': '주소를 찾을 수 없습니다 (주소가 맞는지, 사내망·VPN에 연결돼 있는지 확인하세요)',
    'ERR_CONNECTION_TIMED_OUT': '서버가 응답하지 않습니다',
    'ERR_CONNECTION_RESET': '연결이 끊겼습니다',
    'ERR_INTERNET_DISCONNECTED': '네트워크에 연결돼 있지 않습니다',
    'ERR_ADDRESS_UNREACHABLE': '그 주소에 닿을 수 없습니다',
    'ERR_TOO_MANY_REDIRECTS': '주소가 계속 다른 곳으로 넘겨져 들어가지 못했습니다',
    'ERR_EMPTY_RESPONSE': '서버가 빈 응답을 보냈습니다',
    'ERR_SSL_PROTOCOL_ERROR': '보안 연결에 실패했습니다',
    'ERR_CERT_AUTHORITY_INVALID': '인증서를 신뢰할 수 없습니다 (설정에서 "인증서 경고를 넘기고 검사" 를 켜보세요)',
    'ERR_CERT_COMMON_NAME_INVALID': '인증서의 주소가 맞지 않습니다 (설정에서 "인증서 경고를 넘기고 검사" 를 켜보세요)',
    'ERR_CERT_DATE_INVALID': '인증서 기간이 지났습니다 (설정에서 "인증서 경고를 넘기고 검사" 를 켜보세요)',
    'ERR_ABORTED': '다른 이동이 끼어들어 중단됐습니다',
  };
  for (const [code, text] of Object.entries(pick)) {
    if (m.includes(code)) return text;
  }
  if (/interrupted by another navigation/i.test(m)) return '다른 이동이 끼어들어 중단됐습니다';
  if (/Timeout .*exceeded/i.test(m)) return '정해진 시간 안에 페이지가 열리지 않았습니다';
  if (/net::/i.test(m)) return `연결에 실패했습니다 (${(m.match(/net::(\w+)/) || [])[1] || '원인 불명'})`;
  return m.split('\n')[0].slice(0, 140);
}

/** 요청이 실패한 이유 (짧게) */
function explainRequestFailure(errorText) {
  const m = String(errorText || '').replace(/^net::/, '');
  const pick = {
    'ERR_CONNECTION_REFUSED': '서버가 연결을 거부함',
    'ERR_NAME_NOT_RESOLVED': '주소를 찾을 수 없음',
    'ERR_CONNECTION_TIMED_OUT': '서버가 응답하지 않음',
    'ERR_CONNECTION_RESET': '연결이 끊김',
    'ERR_EMPTY_RESPONSE': '빈 응답',
    'ERR_FAILED': '요청 실패',
    'ERR_TIMED_OUT': '시간 초과',
  };
  return pick[m] || m || '원인 불명';
}

module.exports = { explainClick, explainNavigation, explainRequestFailure };
