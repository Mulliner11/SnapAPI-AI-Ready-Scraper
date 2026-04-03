# Pre-installed Chromium + full system libs (glib, nss, etc.) — avoids Nixpacks/apt drift.
# Pin `playwright` in package.json to the same line as this tag (currently 1.42.0).
FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Install deps first for better layer cache
COPY package.json package-lock.json* ./
RUN npm ci

# App source + Prisma schema
COPY . .

# Client already generated in postinstall; explicit step for clarity in CI logs
RUN npx prisma generate

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "index.js"]
