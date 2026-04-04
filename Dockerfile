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

# 5. 启动：db push 与当前 Railway 库状态最稳妥（避免 P3005 等迁移历史问题）
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && exec node index.js"]
