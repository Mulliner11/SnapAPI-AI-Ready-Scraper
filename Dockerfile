FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# 1. 仅复制 lock 与 manifest，最大化 Docker 层缓存
COPY package.json package-lock.json ./

# 2. 安装依赖（不跑 postinstall；Prisma Client 在复制完整代码后再 generate）
RUN npm ci --ignore-scripts

# 3. 复制源码、prisma/schema.prisma 与 migrations（generate 需要 schema）
COPY . .

# 4. 生成 Prisma Client（schema 使用 env("DATABASE_URL")，构建阶段需占位值，不会连接数据库）
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" npx prisma generate

ENV NODE_ENV=production

EXPOSE 3000

# 5. 启动时使用 Railway 注入的真实 DATABASE_URL；用 migrate deploy 应用已提交的迁移（勿用 db push --accept-data-loss）
CMD ["sh", "-c", "npx prisma migrate deploy && exec node index.js"]
