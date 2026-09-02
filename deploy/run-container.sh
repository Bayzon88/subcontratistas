#!/usr/bin/env bash
#
# Start the subcontratistas container behind Traefik.
#
# Called by .github/workflows/deploy.yml for BOTH the deploy and the rollback. The two
# used to be copy-pasted `docker run` blocks; every label added here would have had to
# be added twice, and a rollback that drifted from the deploy would quietly serve the
# old image with the wrong routing.
#
# Usage: run-container.sh <image>
set -euo pipefail

image="${1:?usage: run-container.sh <image>}"

: "${CONTAINER:?}" "${APP_PORT:?}" "${HOST_PORT:?}"
: "${TRAEFIK_NETWORK:?}" "${APP_HOST:?}" "${CERT_RESOLVER:?}"

docker rm -f "$CONTAINER" 2>/dev/null || true

# Traefik does NOT reach the app through the published host port. It resolves the
# container on TRAEFIK_NETWORK and connects to APP_PORT inside it - which is why the
# container has to join that network and why loadbalancer.server.port is the container
# port, not HOST_PORT. The -p publish below is a loopback-only door for debugging on
# the box itself; nothing external depends on it.
#
# --init: server.js forks src/cli.js per run, and PID 1 has to reap it.
# No volume: every run is self-contained and the report is downloaded, not kept.
docker run -d \
    --name "$CONTAINER" \
    --init \
    --restart unless-stopped \
    --network "$TRAEFIK_NETWORK" \
    -p "127.0.0.1:$HOST_PORT:$APP_PORT" \
    -e NODE_ENV=production \
    -e PORT="$APP_PORT" \
    --label "traefik.enable=true" \
    --label "traefik.docker.network=$TRAEFIK_NETWORK" \
    --label "traefik.http.routers.$CONTAINER.rule=Host(\`$APP_HOST\`)" \
    --label "traefik.http.routers.$CONTAINER.entrypoints=websecure" \
    --label "traefik.http.routers.$CONTAINER.tls.certresolver=$CERT_RESOLVER" \
    --label "traefik.http.services.$CONTAINER.loadbalancer.server.port=$APP_PORT" \
    "$image"
