# Official Playwright image: Chromium + libglib / NSS / etc. — no Nixpacks or manual apt.
# Keep `playwright` in package.json aligned with this tag (1.42.0).
FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Image already ships browsers; skip download during npm install / lifecycle hooks.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm install

COPY . .

RUN npx prisma generate

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "index.js"]
