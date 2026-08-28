# OpenTV's server, self-hosted.
#
# ONE STAGE, ON PURPOSE. There is nothing to compile: `tsx` runs the TypeScript
# the Worker already runs, so a build stage would exist only to produce a `dist`
# nobody reads. The image is Node, the source, and one native module.
#
# better-sqlite3 IS NATIVE, which is the only reason the base is not `-slim`
# without python3 and a compiler beside it. It has prebuilt binaries for common
# platforms and falls back to building; the build tools are dropped from the
# final image either way.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# `--omit=dev` would drop tsx, which is what runs the server. The dev/prod split
# in a repository whose "build" is "run the source" is not a useful one.
RUN npm install --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY selfhost ./selfhost
COPY migrations ./migrations
COPY tsconfig.json ./

# Everything the instance owns lives here: the SQLite file, the pictures, the
# avatars. Mount it. Backing this directory up IS backing the server up.
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787

# No shell form: signals reach node directly, so `docker stop` is a clean exit
# rather than a ten-second wait and a kill.
CMD ["npx", "tsx", "selfhost/server.ts"]
