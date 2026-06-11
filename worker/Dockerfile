# Cloud X-broadcast capture worker — self-contained (build context = worker/).
# On Railway: create a service with Root Directory = "worker" and it auto-builds this Dockerfile.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

# Install deps first (layer caching), then ensure the matching Chromium build is present.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npx playwright install chromium

# App code (worker + the vendored parser it imports).
COPY . .

# Poll mode (no URL arg) — discovers broadcasts from the backend's /x/active.
CMD ["node", "x-broadcast-worker.mjs"]
