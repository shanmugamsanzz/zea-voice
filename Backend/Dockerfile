FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY migrations ./migrations
COPY src ./src
# Verification commands are part of the production activation workflow. Keep
# this directory-level copy in sync automatically when a new verify-*.js gate
# is added instead of maintaining a fragile per-file allowlist here.
COPY scripts ./scripts
# Regression fixtures follow the same rule: every committed fixture used by a
# production verification command must be available in the runtime image.
COPY fixtures ./fixtures

RUN mkdir -p /app/artifacts && chown -R node:node /app/artifacts

USER node
EXPOSE 1112

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1112/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
