FROM node:18-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./

# 创建数据持久化目录
RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 6821

CMD ["node", "server.js"]
