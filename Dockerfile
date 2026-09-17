# node:sqlite (used by the default SQLite backend) needs Node 22+ as a
# stable API - this repo was developed and tested against 22.22.2, so the
# base image is pinned to the 22.x line rather than "latest"/"lts" floating
# tags that could silently move to a version where node:sqlite's behavior
# has changed.
FROM node:22-slim

# Only used if FINOPS_DB_DRIVER=postgres AND FINOPS_MULTI_TENANT is unset -
# the pg driver itself is pure JS (no native compile step), so no extra
# system packages are needed here for either backend.
WORKDIR /app

# Copy manifests first so `npm ci` is only re-run when dependencies actually
# change, not on every source-code edit - standard Docker layer-caching
# practice, meaningfully speeds up iterative local builds.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# data/ and logs/ are where SQLite files, backups, and rotated logs land
# (see db.js / backup.js / logger.js) - created here so the container
# doesn't have to write to its own image layer at runtime, and so a
# `docker run -v` volume mount has somewhere to attach.
RUN mkdir -p data logs && \
    addgroup --system finops && adduser --system --ingroup finops finops && \
    chown -R finops:finops /app

USER finops

ENV PORT=4000
# Binds 0.0.0.0 INSIDE the container by design - the container boundary
# itself is the access control (nothing outside the container/network can
# reach it unless you publish the port), unlike a bare-metal install where
# 127.0.0.1-by-default protects against every other process/user on the
# same host. See server/index.js's own comment on FINOPS_HOST for the
# bare-metal reasoning this intentionally differs from.
ENV FINOPS_HOST=0.0.0.0
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server/index.js"]
