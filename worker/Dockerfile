# Cloud X-broadcast capture worker. Build context = repo ROOT (so the shared parser at
# server/src/ingesters/xBroadcastParse.js is available at the path the worker imports).
# On Railway: set this service's Root Directory = "/" and Dockerfile Path = "worker/Dockerfile".
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# Install worker deps first (better layer caching), then ensure the matching Chromium build.
COPY worker/package.json worker/package-lock.json* ./worker/
RUN cd worker && npm ci --omit=dev && npx playwright install chromium

# App code: the worker + the shared parser it imports via ../server/...
COPY worker/ ./worker/
COPY server/src/ingesters/xBroadcastParse.js ./server/src/ingesters/xBroadcastParse.js

WORKDIR /app/worker
# Poll mode (no URL arg) — discovers broadcasts from the backend's /x/active.
CMD ["node", "x-broadcast-worker.mjs"]
