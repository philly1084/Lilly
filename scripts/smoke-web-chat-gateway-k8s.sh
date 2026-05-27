#!/usr/bin/env bash
set -euo pipefail

# Reads existing Kubernetes Secrets into process-local env vars, then runs the
# secret-safe web-chat/gateway smoke. This script never prints secret values and
# does not mutate the cluster.

KIMIBUILT_NAMESPACE="${KIMIBUILT_NAMESPACE:-kimibuilt}"
KIMIBUILT_SECRET="${KIMIBUILT_SECRET:-kimibuilt-secrets}"
KIMIBUILT_USERNAME_KEY="${KIMIBUILT_USERNAME_KEY:-LILLYBUILT_AUTH_USERNAME}"
KIMIBUILT_PASSWORD_KEY="${KIMIBUILT_PASSWORD_KEY:-LILLYBUILT_AUTH_PASSWORD}"
KIMIBUILT_GATEWAY_TOKEN_KEY="${KIMIBUILT_GATEWAY_TOKEN_KEY:-OPENAI_API_KEY}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: scripts/smoke-web-chat-gateway-k8s.sh [smoke options]

Secret-safe Kubernetes wrapper for scripts/smoke-web-chat-gateway.mjs.

Environment:
  KIMIBUILT_NAMESPACE=kimibuilt
  KIMIBUILT_SECRET=kimibuilt-secrets
  KIMIBUILT_USERNAME_KEY=LILLYBUILT_AUTH_USERNAME
  KIMIBUILT_PASSWORD_KEY=LILLYBUILT_AUTH_PASSWORD
  KIMIBUILT_GATEWAY_TOKEN_KEY=OPENAI_API_KEY

Examples:
  scripts/smoke-web-chat-gateway-k8s.sh --timeout 90000
  scripts/smoke-web-chat-gateway-k8s.sh --skip-chat
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[web-chat-gateway-smoke] missing required command: $1" >&2
    exit 1
  fi
}

secret_value() {
  local key="$1"
  local encoded
  encoded="$(kubectl -n "$KIMIBUILT_NAMESPACE" get secret "$KIMIBUILT_SECRET" -o "jsonpath={.data.${key}}" 2>/dev/null || true)"
  if [[ -z "$encoded" ]]; then
    echo "[web-chat-gateway-smoke] missing secret key ${KIMIBUILT_NAMESPACE}/${KIMIBUILT_SECRET}:${key}" >&2
    exit 1
  fi
  printf '%s' "$encoded" | base64 -d
}

require_command kubectl
require_command node
require_command base64

export KIMIBUILT_SMOKE_USERNAME
export KIMIBUILT_SMOKE_PASSWORD
export KIMIBUILT_SMOKE_GATEWAY_TOKEN

KIMIBUILT_SMOKE_USERNAME="$(secret_value "$KIMIBUILT_USERNAME_KEY")"
KIMIBUILT_SMOKE_PASSWORD="$(secret_value "$KIMIBUILT_PASSWORD_KEY")"
KIMIBUILT_SMOKE_GATEWAY_TOKEN="$(secret_value "$KIMIBUILT_GATEWAY_TOKEN_KEY")"

node "$SCRIPT_DIR/smoke-web-chat-gateway.mjs" "$@"
