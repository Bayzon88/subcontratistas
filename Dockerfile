# The subcontratistas monthly consolidation app.
#
# One process, no volumes: every run stages its inputs in a fresh mkdtemp under
# config.TMP_ROOT (/tmp in the container) and a `finally` removes it, and the
# generated report is streamed out over GET /descargar/:id. Nothing on disk is
# meant to survive the container, so there is nothing to mount.
#
# src/server.js forks src/cli.js per run, so the image needs the full source tree
# and a real init (see --init in the deploy workflow) to reap the children.

FROM node:22-slim

# config.js only loads dotenv when NODE_ENV !== "production"; in the container every
# setting comes from the environment, so there is no .env to ship.
ENV NODE_ENV=production
ENV PORT=50001

WORKDIR /app

# Dependencies first so the layer survives source-only changes. package.json declares
# no devDependencies, so --omit=dev still installs everything `npm test` needs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# REPORTES_DIR is gitignored, so it is not in the build context. The server mkdirs it
# at run time, but creating it here keeps it owned by the unprivileged user.
RUN mkdir -p src/reportes && chown -R node:node /app

USER node

EXPOSE 50001

# /api/periodo is a cheap JSON GET with no side effects. node:22-slim has no curl, and
# Node 22 has a global fetch, so the check needs no extra package.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||50001)+'/api/periodo').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
