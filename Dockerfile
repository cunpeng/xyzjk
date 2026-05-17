# 支持 amd64 和 arm64 架构
FROM --platform=$TARGETOS/$TARGETARCH node:18-alpine

LABEL org.opencontainers.image.version="1.02"
LABEL org.opencontainers.image.description="xyzjk arm/amd multi-arch"

WORKDIR /app

RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    apk del tzdata

COPY package*.json ./

RUN npm install --production

COPY server.js ./

# 创建数据持久化目录
RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 6821

CMD ["node", "server.js"]
