# Образ приложения CRM ОР ПСД.
# Сборки нет: исходники на TypeScript исполняются Node.js напрямую
# (--experimental-strip-types), поэтому образ содержит только зависимости
# и исходный код. Это упрощает развёртывание в закрытом контуре.

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# Зависимости ставятся отдельным слоем: пересобираются только при изменении package-lock.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY design ./design

# Каталог файлов актов: в рабочем составе монтируется томом.
RUN mkdir -p /data/storage && chown -R node:node /data

# Приложение работает от непривилегированного пользователя.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/server/index.ts"]
