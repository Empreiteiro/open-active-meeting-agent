# The agent's body: Chromium (patchright) + a virtual display (Xvfb) + virtual
# audio (PulseAudio) + ffmpeg to record the call and the shared screen.
# Build once:  docker build -t open-meeting-agent-bot:latest bot/
# The Playwright image of the same version as patchright (package.json): its
# Chromium is the one patchright drives, so nothing is downloaded at build time.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
      pulseaudio pulseaudio-utils ffmpeg xvfb dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# A no-op when the base image already has patchright's Chromium revision.
RUN npx patchright install chromium

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS runtime
ENV NODE_ENV=production
ENV DISPLAY=:99
ENV TEMP_DIR=/tmp/meeting-agent
ENV OUT_DIR=/out
# root: system PulseAudio + Xvfb are simpler in a single-use container.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /tmp/meeting-agent /out
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]
