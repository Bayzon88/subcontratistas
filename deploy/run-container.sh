#!/usr/bin/env bash
#
# Start the subcontratistas container behind Traefik.
#
# Called by .github/workflows/deploy.yml for BOTH the deploy and the rollback. The two
# used to be copy-pasted `docker run` blocks; every label added here would have had to
# be added twice, and a rollback that drifted from the deploy would quietly serve the
# old image with the wrong routing.
#
# Usage: run-container.sh <image>   start the container
#        run-container.sh --check   validate configuration only, change nothing
#
# --check exists so deploy.yml can fail a misconfiguration before the build and the
# test suite run, and - because every later step is then skipped rather than failed -
# so the rollback step does not report a failure for a deploy that never touched the
# running container.
set -euo pipefail

mode="${1:?usage: run-container.sh <image> | --check}"

: "${CONTAINER:?}" "${APP_PORT:?}" "${HOST_PORT:?}"
: "${TRAEFIK_NETWORK:?}" "${CERT_RESOLVER:?}" "${APP_SUBDOMAIN:?}"

# The rule below reads ${APP_SUBDOMAIN}.${DOMAIN}, the same shape the homelab compose
# stack writes as prometheus.${DOMAIN}, so the host is assembled in the label rather
# than spelled out anywhere.
#
# DOMAIN can come from the workflow (a repository variable) or, since the runner is the
# host the stack runs on, from the env file compose already reads - so the domain does
# not have to be written down in two places. An explicit value wins over the file.
#
# The file is grepped, never sourced: a compose .env holds passwords, and sourcing it
# would execute whatever is in it and pull every key it defines into this environment.
if [[ -z "${DOMAIN:-}" && -n "${DOMAIN_ENV_FILE:-}" ]]; then
    if [[ ! -r "$DOMAIN_ENV_FILE" ]]; then
        echo "DOMAIN_ENV_FILE '$DOMAIN_ENV_FILE' is not readable by $(id -un)." >&2
        echo "The runner user needs read access to it, or set a DOMAIN repository variable instead." >&2
        exit 1
    fi
    DOMAIN="$(sed -n 's/^[[:space:]]*DOMAIN[[:space:]]*=[[:space:]]*//p' "$DOMAIN_ENV_FILE" \
              | tail -n1 | sed "s/^[\"']//; s/[\"']$//")"
    [[ -n "$DOMAIN" ]] || { echo "no DOMAIN= line in '$DOMAIN_ENV_FILE'" >&2; exit 1; }
fi

# An unset variable expands to the empty string, which would build "subcontratistas." -
# a route that can never match and a cert request that can never pass.
: "${DOMAIN:?set a DOMAIN repository variable, or point DOMAIN_ENV_FILE at the env file that defines it}"

# A wrong network name would otherwise surface only after the running container had
# been removed - and the rollback runs this same script, so it would fail the same way
# and leave nothing serving at all. Check while the old container is still up.
if ! docker network inspect "$TRAEFIK_NETWORK" >/dev/null 2>&1; then
    echo "network '$TRAEFIK_NETWORK' does not exist on this host. Available:" >&2
    docker network ls --format '  {{.Name}}' >&2
    exit 1
fi

if [[ "$mode" == "--check" ]]; then
    echo "configuration ok: https://${APP_SUBDOMAIN}.${DOMAIN} -> $CONTAINER:$APP_PORT on $TRAEFIK_NETWORK"
    exit 0
fi
image="$mode"

docker rm -f "$CONTAINER" 2>/dev/null || true

# Traefik does NOT reach the app through the published host port. It resolves the
# container on TRAEFIK_NETWORK and connects to APP_PORT inside it - which is why the
# container has to join that network and why loadbalancer.server.port is the container
# port, not HOST_PORT. The -p publish below is a loopback-only door for debugging on
# the box itself; nothing external depends on it.
#
# --init: server.js forks src/cli.js per run, and PID 1 has to reap it.
# No volume: every run is self-contained and the report is downloaded, not kept.
labels=(
    --label "traefik.enable=true"
    --label "traefik.docker.network=$TRAEFIK_NETWORK"
    --label "traefik.http.routers.$CONTAINER.rule=Host(\`${APP_SUBDOMAIN}.${DOMAIN}\`)"
    --label "traefik.http.routers.$CONTAINER.entrypoints=websecure"
    --label "traefik.http.routers.$CONTAINER.tls.certresolver=$CERT_RESOLVER"
    --label "traefik.http.services.$CONTAINER.loadbalancer.server.port=$APP_PORT"
)

# The app has no authentication of its own - no login, no session. That was fine while
# it answered to subcontratistas.local on the LAN (rework-plan/05 line 16 records the
# constraint and says to use basic-auth or a VPN if it ever changes). A public hostname
# changes it: without a middleware, anyone who guesses the subdomain can upload
# subcontractor workbooks and download the consolidated report. So it goes behind the
# same middleware prometheus uses. Set TRAEFIK_MIDDLEWARES to "" to serve it open.
if [[ -n "${TRAEFIK_MIDDLEWARES:-}" ]]; then
    labels+=(--label "traefik.http.routers.$CONTAINER.middlewares=$TRAEFIK_MIDDLEWARES")
fi

echo "routing https://${APP_SUBDOMAIN}.${DOMAIN} -> $CONTAINER:$APP_PORT on $TRAEFIK_NETWORK"

docker run -d \
    --name "$CONTAINER" \
    --init \
    --restart unless-stopped \
    --network "$TRAEFIK_NETWORK" \
    -p "127.0.0.1:$HOST_PORT:$APP_PORT" \
    -e NODE_ENV=production \
    -e PORT="$APP_PORT" \
    "${labels[@]}" \
    "$image"
