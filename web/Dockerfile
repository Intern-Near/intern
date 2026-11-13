# The website on Railway (or any Docker host). Build from the REPOSITORY ROOT, because the site reads
# ../interface/*.json and ../stream/src/cues.ts while it is built:
#   docker build -f web/Dockerfile -t intern-web .
# On Railway: one service, variable RAILWAY_DOCKERFILE_PATH=web/Dockerfile.
# Private variables (optional, for the Intern's voice): ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID.
FROM node:24-bookworm-slim AS build
WORKDIR /repo
COPY interface ./interface
COPY stream/src ./stream/src
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
RUN cd web && npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/web/dist ./dist
COPY web/server ./server
COPY interface/lines.json ./lines.json
USER node
CMD ["node", "server/server.mjs"]
