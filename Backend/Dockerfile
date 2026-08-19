FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY migrations ./migrations
COPY src ./src
COPY scripts/verify-live-production-acceptance.js ./scripts/verify-live-production-acceptance.js
COPY fixtures/failed-call-2026-08-19-production.json ./fixtures/failed-call-2026-08-19-production.json

RUN mkdir -p /app/artifacts && chown -R node:node /app/artifacts

USER node
EXPOSE 1112

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1112/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
