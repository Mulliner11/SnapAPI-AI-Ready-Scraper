FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# 依赖清单（npm ci 需要；与后续 COPY . 分层缓存）
COPY package.json package-lock.json ./

# 1. 安装依赖，明确跳过所有脚本（防止提前触发 generate）
RUN npm ci --ignore-scripts

# 2. 复制所有文件
COPY . .

# 3. 设置构建时占位变量并生成 Client（运行时由 Railway 覆盖 DATABASE_URL）
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN npx prisma generate

ENV NODE_ENV=production

EXPOSE 3000

# 4. 启动命令（保持 db push 模式）
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && exec node index.js"]
