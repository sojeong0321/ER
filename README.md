<div align="center">

# 🩺 ER — Error Radar

**운영 URL만 넣으면, 화면을 순회하며 "안 눌리는 버튼"까지 잡아내는 자동 스모크 테스트 도구**

버튼을 눌러도 아무 반응이 없는 **무감(NO-RESPONSE)** 결함 —
에러 로그조차 남기지 않아 놓치기 쉬운 그 결함을 잡는 것이 ER의 존재 이유입니다.

<br>

![status](https://img.shields.io/badge/status-PoC%20검증%20완료-2f9d6b?style=flat-square)
![engine](https://img.shields.io/badge/engine-Playwright-2f5bea?style=flat-square)
![node](https://img.shields.io/badge/node-Chromium-c67a12?style=flat-square)
![made by](https://img.shields.io/badge/made%20by-QA%20couple%20💍-d1435b?style=flat-square)

</div>

---

## 왜 만들었나

> 개발자가 기본 스모크 테스트도 없이 QA로 넘길 때,
> "이거 한 번이라도 눌러봤어요?" 소리가 나오는 그 결함들을 자동으로 걸러내기 위해.

반복되는 기초 결함 검수에 지쳐 **"넘기기 전에 최소한 이건 됐어야지"** 레벨을
자동으로 리포트하는 도구를 직접 만들었습니다.

일반적인 모니터링 도구는 **에러**는 잡지만, **"클릭해도 아무 일도 안 일어나는" 무감 상태**는 놓칩니다.
에러가 안 나기 때문입니다. ER은 클릭 전후의 변화 신호를 관찰해 이 무감 결함까지 판정합니다.

---

## 무엇을 잡나 — 결함 4단계 판정

클릭 직전 상태를 스냅샷한 뒤, 클릭하고, 관찰 대기시간 동안 5개 신호(DOM · NET · URL · CON · VIS)의 변화를 수집해 판정합니다.

| 판정 | 의미 | 기준 |
|:---:|------|------|
| 🟢 **PASS** | 정상 동작 | 변화 신호 1개 이상 감지 |
| 🔴 **ERROR** | 에러 발생 | JS 예외 또는 서버 4xx/5xx |
| 🟠 **NO-RESPONSE** | **무감 — 눌러도 반응 없음** | DOM·NET·URL 전부 무변화 |
| ⚪ **EXCLUDED** | 검사 제외 | disabled 요소 · 파괴적 동작(삭제·결제 등) |

**검증 결과 (`test-target.html` 기준): 10개 요소 오탐 0건.**
특히 서버 500 에러는 `ERROR`로, 정상 네트워크 요청은 `PASS`로 구분하며,
1.2초 뒤 반응하는 비동기 버튼도 성급히 무감 처리하지 않고 `PASS`로 판정합니다.

---

## 핵심 특징

- **화면 순회** — 시작 URL에서 같은 도메인 링크를 따라 이동하며 검사 대상을 확장 (단일 페이지에 머물지 않음)
- **무감 탐지** — 핸들러 미연결·빈 핸들러 버튼을 정확히 잡아냄
- **오탐 관리** — 네트워크 실패를 코드 에러와 구분, 비동기 지연 반응 허용
- **개발·사내망 대응** — 자체 서명 SSL 인증서 무시 옵션 (`ignoreHTTPSErrors`)
- **파괴적 동작 보호** — 삭제·결제·탈퇴 등은 제외 규칙으로 클릭 차단
- **리포트** — 대시보드(Pass율·페이지별 커버리지) + 필터 가능한 결과 리스트 + HTML/Excel/PDF export

---

## 빠른 시작

```bash
# 의존성 설치
npm install

# 단일 스캔 (CLI)
node scan.js https://your-target-url.com

# 웹 대시보드
node server.js
# → 브라우저에서 http://localhost:3000
```

설정은 `config.json`에서 관리합니다 (스캔 범위, 제외 규칙, 관찰 대기시간, 로그인 정보 등).

---

## 프로젝트 구조

| 파일 | 역할 |
|------|------|
| `smoke-engine.js` | 판정 엔진 — 클릭·변화 감지·4단계 분류 (검증 완료) |
| `scan.js` | CLI 스캔 실행 |
| `server.js` | 웹 대시보드 서버 |
| `test-target.html` | 판정 검증용 테스트 페이지 (회귀 테스트 기준) |
| `smoke-test-mockup.html` | UI 목업 |
| `config.json` | 스캔 설정 |
| `기획안_자동스모크테스트.md` | 배경·개념 |
| `기능정의서_자동스모크테스트.md` | 기능 명세 (F-01~F-13) |

---

## 로드맵

- [x] **PoC** — 클릭 + 무감/에러 판정 (오탐 0건 검증)
- [ ] 페이지 순회(크롤링) 정식 지원
- [ ] 로그인 세션 처리
- [ ] 스크린샷 캡처 · DOM diff 정밀화
- [ ] 재검사 이력 비교 · 스케줄 · 알림(Slack/메일)

---

<div align="center">

made with 🩺 &nbsp;by a **QA couple**
<br>
<sub>아픈 버튼은 저희가 응급실로 데려갈게요.</sub>

</div>
