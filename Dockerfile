FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# 1. 先复制 package 文件
COPY package*.json ./

# 2. 安装依赖 (此时不运行 postinstall)
RUN npm ci --ignore-scripts

# 3. 复制所有代码 (包括 schema.prisma)
COPY . .

# 4. 手动生成 Prisma Client
RUN npx prisma generate

CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node index.js"]
