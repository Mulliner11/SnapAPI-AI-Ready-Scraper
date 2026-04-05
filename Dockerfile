# Playwright + Chromium (align npm `playwright` with image major when possible)
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package.json package-lock.json ./

# 安装依赖：跳过所有 lifecycle 脚本，避免任何包在安装阶段触发 prisma generate
RUN npm ci --ignore-scripts

COPY . .

# 构建期仅此层需要占位 URL；不写入 ENV，避免覆盖 Railway 运行时注入的 DATABASE_URL
RUN DATABASE_URL="postgresql://noop:noop@localhost:5432/noop" npx prisma generate

ENV NODE_ENV=production

EXPOSE 3000

CMD ["sh", "-c", "npx prisma db push --accept-data-loss && exec node index.js"]
