FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# 依赖清单（npm ci 需要；与后续 COPY . 分层缓存）
COPY package.json package-lock.json ./

# 1. 安装依赖，明确跳过所有脚本（防止提前触发 generate）
RUN npm ci --ignore-scripts

# 2. 复制所有文件
COPY . .

# 3. 仅在本层行内设置 DATABASE_URL，生成 Client；镜像内不保留该变量，运行时由 Railway 注入
RUN DATABASE_URL="postgresql://noop:noop@localhost:5432/noop" npx prisma generate

ENV NODE_ENV=production

EXPOSE 3000

# 4. 启动命令（保持 db push 模式）
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && exec node index.js"]
