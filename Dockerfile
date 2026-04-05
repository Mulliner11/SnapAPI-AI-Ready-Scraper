FROM mcr.microsoft.com/playwright:v1.42.0-jammy
WORKDIR /app
# 先复制 package 文件
COPY package*.json ./
# 安装依赖，跳过脚本，防止构建时报错
RUN npm ci --ignore-scripts
# 复制所有代码（包括刚刚移入 prisma 文件夹的 schema）
COPY . .
# 在构建阶段生成 Client (使用占位变量)
RUN DATABASE_URL='postgresql://noop:noop@localhost:5432/noop' npx prisma generate
# 暴露端口
EXPOSE 3000
# 启动命令：强制同步数据库并启动
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && exec node index.js"]
