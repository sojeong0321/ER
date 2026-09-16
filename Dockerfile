# Playwright 공식 이미지 — Chromium 과 실행에 필요한 시스템 라이브러리가 이미 들어있다.
# 직접 설치하는 방식(npx playwright install --with-deps)은 PaaS 빌드에서 권한 문제로
# 실패하는 경우가 많아, 브라우저가 포함된 이미지를 쓰는 편이 확실하다.
# 태그의 버전은 package.json 의 playwright 버전과 맞춘다.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
# 이미지에 브라우저가 이미 있으므로 postinstall(playwright install)은 건너뛴다
RUN npm ci --omit=dev --ignore-scripts

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]
