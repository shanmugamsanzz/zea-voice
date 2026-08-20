FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY migrations ./migrations
COPY src ./src
COPY scripts/verify-live-production-acceptance.js ./scripts/verify-live-production-acceptance.js
COPY scripts/verify-universal-entity-routing.js ./scripts/verify-universal-entity-routing.js
COPY scripts/verify-grounding-action-runtime.js ./scripts/verify-grounding-action-runtime.js
COPY scripts/verify-tenant-regression-generator.js ./scripts/verify-tenant-regression-generator.js
COPY scripts/verify-tenant-data-regression.js ./scripts/verify-tenant-data-regression.js
COPY scripts/lib/tenant-regression-scenarios.js ./scripts/lib/tenant-regression-scenarios.js
COPY fixtures/failed-call-2026-08-19-production.json ./fixtures/failed-call-2026-08-19-production.json
COPY fixtures/complete-live-call-2026-08-20-regression.json ./fixtures/complete-live-call-2026-08-20-regression.json

RUN mkdir -p /app/artifacts && chown -R node:node /app/artifacts

USER node
EXPOSE 1112

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1112/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
