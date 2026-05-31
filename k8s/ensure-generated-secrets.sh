#!/usr/bin/env bash
set -euo pipefail

KIMIBUILT_NAMESPACE="${KIMIBUILT_NAMESPACE:-kimibuilt}"
PLATFORM_NAMESPACE="${PLATFORM_NAMESPACE:-agent-platform}"
ROTATE_SECRETS="${ROTATE_SECRETS:-0}"
SHOW_SECRET_VALUES="${SHOW_SECRET_VALUES:-0}"
CREATE_KIMIBUILT_SECRETS="${CREATE_KIMIBUILT_SECRETS:-1}"
CREATE_PLATFORM_SECRETS="${CREATE_PLATFORM_SECRETS:-1}"
KUBECTL="${KUBECTL:-}"

usage() {
  cat <<'EOF'
Generate or update KimiBuilt Kubernetes secrets with strong defaults.

By default this script preserves existing non-placeholder secret values and only
generates missing or placeholder values. Set ROTATE_SECRETS=1 to replace all
generated values.

Environment variables:
  CREATE_KIMIBUILT_SECRETS   Set to 0 to skip namespace kimibuilt secrets.
  CREATE_PLATFORM_SECRETS    Set to 0 to skip namespace agent-platform secrets.
  KIMIBUILT_NAMESPACE        Default: kimibuilt
  PLATFORM_NAMESPACE         Default: agent-platform
  ROTATE_SECRETS             Set to 1 to rotate generated secret values.
  SHOW_SECRET_VALUES         Set to 1 to print decoded values after applying.
  KUBECTL                    Override kubectl command, e.g. "sudo k3s kubectl".

Optional overrides:
  OPENAI_API_KEY
  N8N_API_KEY
  REMOTE_CLI_MCP_BEARER_TOKEN
  OPENAI_MEDIA_API_KEY
  PERPLEXITY_API_KEY
  KIMIBUILT_AUTH_USERNAME
  KIMIBUILT_AUTH_PASSWORD
  KIMIBUILT_JWT_SECRET
  LILLYBUILT_AUTH_USERNAME
  LILLYBUILT_AUTH_PASSWORD
  LILLYBUILT_JWT_SECRET
  KIMIBUILT_REMOTE_RUNNER_TOKEN
  POSTGRES_PASSWORD
  GITLAB_ROOT_USERNAME
  GITLAB_ROOT_PASSWORD
  GITLAB_ROOT_EMAIL
  GITLAB_RUNNER_TOKEN
  GITLAB_REGISTRY_HOST
  GITLAB_REGISTRY_USERNAME
  GITLAB_REGISTRY_PASSWORD
  KIMIBUILT_BUILD_EVENTS_URL
  KIMIBUILT_BUILD_EVENTS_SECRET
  KIMIBUILT_BUILD_EVENTS_INSECURE
  BUILDKIT_HOST

Examples:
  ./k8s/ensure-generated-secrets.sh
  SHOW_SECRET_VALUES=1 ./k8s/ensure-generated-secrets.sh
  ROTATE_SECRETS=1 SHOW_SECRET_VALUES=1 ./k8s/ensure-generated-secrets.sh
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

kubectl_cmd() {
  if [[ -n "$KUBECTL" ]]; then
    # Intentionally allow a command with arguments, such as: sudo k3s kubectl.
    # shellcheck disable=SC2086
    $KUBECTL "$@"
    return
  fi
  if command -v kubectl >/dev/null 2>&1; then
    kubectl "$@"
    return
  fi
  if command -v k3s >/dev/null 2>&1; then
    k3s kubectl "$@"
    return
  fi
  echo "kubectl or k3s is required" >&2
  exit 1
}

require_cluster_access() {
  if ! kubectl_cmd get namespace default >/dev/null 2>&1; then
    echo "ERROR: kubectl is not connected to the target k3s cluster." >&2
    echo "Set KUBECONFIG correctly or run with KUBECTL=\"sudo k3s kubectl\" on the server." >&2
    exit 1
  fi
}

is_enabled() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

is_placeholder() {
  case "${1:-}" in
    ""|change-me|replace-me|replace-after-gitlab-boot|replace-after-gitea-boot|SET_VIA_KUBECTL_CREATE_SECRET|OPTIONAL_SET_VIA_KUBECTL_CREATE_SECRET)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 36 | tr -d '\r\n'
    return
  fi
  head -c 48 /dev/urandom | base64 | tr -d '\r\n'
}

decode_or_empty() {
  local value="$1"
  if [[ -z "$value" ]]; then
    printf ''
    return
  fi
  printf '%s' "$value" | base64 -d 2>/dev/null || printf ''
}

secret_value() {
  local namespace="$1"
  local secret_name="$2"
  local key="$3"
  local raw=""
  raw="$(kubectl_cmd get secret "$secret_name" -n "$namespace" -o "jsonpath={.data.${key}}" 2>/dev/null || true)"
  decode_or_empty "$raw"
}

choose_secret_value() {
  local env_name="$1"
  local namespace="$2"
  local secret_name="$3"
  local key="$4"
  local fallback="${5:-}"
  local env_value="${!env_name:-}"
  local current_value

  if [[ -n "$env_value" ]]; then
    printf '%s' "$env_value"
    return
  fi

  current_value="$(secret_value "$namespace" "$secret_name" "$key")"
  if ! is_enabled "$ROTATE_SECRETS" && ! is_placeholder "$current_value"; then
    printf '%s' "$current_value"
    return
  fi

  if [[ -n "$fallback" ]]; then
    printf '%s' "$fallback"
    return
  fi

  random_secret
}

ensure_namespace() {
  local namespace="$1"
  kubectl_cmd create namespace "$namespace" --dry-run=client -o yaml | kubectl_cmd apply -f -
}

apply_secret() {
  kubectl_cmd create secret generic "$@" --dry-run=client -o yaml | kubectl_cmd apply -f -
}

print_secret() {
  local namespace="$1"
  local secret_name="$2"
  shift 2
  local key value

  echo
  echo "${namespace}/${secret_name}"
  for key in "$@"; do
    value="$(secret_value "$namespace" "$secret_name" "$key")"
    if is_enabled "$SHOW_SECRET_VALUES"; then
      printf '  %s=%s\n' "$key" "$value"
    else
      if is_placeholder "$value"; then
        printf '  %s=<missing-or-placeholder>\n' "$key"
      else
        printf '  %s=<set>\n' "$key"
      fi
    fi
  done
}

ensure_kimibuilt_secrets() {
  local auth_username auth_password jwt_secret runner_token postgres_password
  local openai_api_key n8n_api_key mcp_bearer_token openai_media_api_key perplexity_api_key
  local docker_host ssh_host ssh_port ssh_username ssh_password ssh_key_path

  ensure_namespace "$KIMIBUILT_NAMESPACE"

  n8n_api_key="$(choose_secret_value N8N_API_KEY "$KIMIBUILT_NAMESPACE" kimibuilt-secrets N8N_API_KEY)"
  mcp_bearer_token="$(choose_secret_value REMOTE_CLI_MCP_BEARER_TOKEN "$KIMIBUILT_NAMESPACE" kimibuilt-secrets REMOTE_CLI_MCP_BEARER_TOKEN "$n8n_api_key")"
  openai_api_key="$(choose_secret_value OPENAI_API_KEY "$KIMIBUILT_NAMESPACE" kimibuilt-secrets OPENAI_API_KEY "$n8n_api_key")"
  openai_media_api_key="$(choose_secret_value OPENAI_MEDIA_API_KEY "$KIMIBUILT_NAMESPACE" kimibuilt-secrets OPENAI_MEDIA_API_KEY)"
  perplexity_api_key="$(choose_secret_value PERPLEXITY_API_KEY "$KIMIBUILT_NAMESPACE" kimibuilt-secrets PERPLEXITY_API_KEY)"
  auth_username="${KIMIBUILT_AUTH_USERNAME:-}"
  if [[ -z "$auth_username" && ! is_enabled "$ROTATE_SECRETS" ]]; then
    auth_username="$(secret_value "$KIMIBUILT_NAMESPACE" kimibuilt-secrets KIMIBUILT_AUTH_USERNAME)"
  fi
  if is_placeholder "$auth_username"; then
    auth_username="$(choose_secret_value LILLYBUILT_AUTH_USERNAME "$KIMIBUILT_NAMESPACE" kimibuilt-secrets LILLYBUILT_AUTH_USERNAME admin)"
  fi
  auth_password="${KIMIBUILT_AUTH_PASSWORD:-}"
  if [[ -z "$auth_password" && ! is_enabled "$ROTATE_SECRETS" ]]; then
    auth_password="$(secret_value "$KIMIBUILT_NAMESPACE" kimibuilt-secrets KIMIBUILT_AUTH_PASSWORD)"
  fi
  if is_placeholder "$auth_password"; then
    auth_password="$(choose_secret_value LILLYBUILT_AUTH_PASSWORD "$KIMIBUILT_NAMESPACE" kimibuilt-secrets LILLYBUILT_AUTH_PASSWORD)"
  fi
  jwt_secret="${KIMIBUILT_JWT_SECRET:-}"
  if [[ -z "$jwt_secret" && ! is_enabled "$ROTATE_SECRETS" ]]; then
    jwt_secret="$(secret_value "$KIMIBUILT_NAMESPACE" kimibuilt-secrets KIMIBUILT_JWT_SECRET)"
  fi
  if is_placeholder "$jwt_secret"; then
    jwt_secret="$(choose_secret_value LILLYBUILT_JWT_SECRET "$KIMIBUILT_NAMESPACE" kimibuilt-secrets LILLYBUILT_JWT_SECRET)"
  fi
  runner_token="$(choose_secret_value KIMIBUILT_REMOTE_RUNNER_TOKEN "$KIMIBUILT_NAMESPACE" kimibuilt-secrets KIMIBUILT_REMOTE_RUNNER_TOKEN)"
  postgres_password="$(choose_secret_value POSTGRES_PASSWORD "$KIMIBUILT_NAMESPACE" kimibuilt-secrets POSTGRES_PASSWORD)"
  docker_host="$(choose_secret_value DOCKER_HOST "$KIMIBUILT_NAMESPACE" kimibuilt-secrets DOCKER_HOST OPTIONAL_SET_VIA_KUBECTL_CREATE_SECRET)"
  ssh_host="$(choose_secret_value KIMIBUILT_SSH_HOST "$KIMIBUILT_NAMESPACE" kimibuilt-secrets KIMIBUILT_SSH_HOST OPTIONAL_SET_VIA_KUBECTL_CREATE_SECRET)"
  ssh_port="$(choose_secret_value KIMIBUILT_SSH_PORT "$KIMIBUILT_NAMESPACE" kimibuilt-secrets KIMIBUILT_SSH_PORT 22)"
  ssh_username="$(choose_secret_value KIMIBUILT_SSH_USERNAME "$KIMIBUILT_NAMESPACE" kimibuilt-secrets KIMIBUILT_SSH_USERNAME OPTIONAL_SET_VIA_KUBECTL_CREATE_SECRET)"
  ssh_password="$(choose_secret_value KIMIBUILT_SSH_PASSWORD "$KIMIBUILT_NAMESPACE" kimibuilt-secrets KIMIBUILT_SSH_PASSWORD OPTIONAL_SET_VIA_KUBECTL_CREATE_SECRET)"
  ssh_key_path="$(choose_secret_value KIMIBUILT_SSH_KEY_PATH "$KIMIBUILT_NAMESPACE" kimibuilt-secrets KIMIBUILT_SSH_KEY_PATH OPTIONAL_SET_VIA_KUBECTL_CREATE_SECRET)"

  echo "Ensuring ${KIMIBUILT_NAMESPACE}/kimibuilt-secrets..."
  apply_secret kimibuilt-secrets \
    --namespace "$KIMIBUILT_NAMESPACE" \
    --from-literal=OPENAI_API_KEY="$openai_api_key" \
    --from-literal=N8N_API_KEY="$n8n_api_key" \
    --from-literal=REMOTE_CLI_MCP_BEARER_TOKEN="$mcp_bearer_token" \
    --from-literal=OPENAI_MEDIA_API_KEY="$openai_media_api_key" \
    --from-literal=PERPLEXITY_API_KEY="$perplexity_api_key" \
    --from-literal=KIMIBUILT_AUTH_USERNAME="$auth_username" \
    --from-literal=KIMIBUILT_AUTH_PASSWORD="$auth_password" \
    --from-literal=KIMIBUILT_JWT_SECRET="$jwt_secret" \
    --from-literal=LILLYBUILT_AUTH_USERNAME="$auth_username" \
    --from-literal=LILLYBUILT_AUTH_PASSWORD="$auth_password" \
    --from-literal=LILLYBUILT_JWT_SECRET="$jwt_secret" \
    --from-literal=DOCKER_HOST="$docker_host" \
    --from-literal=KIMIBUILT_REMOTE_RUNNER_TOKEN="$runner_token" \
    --from-literal=KIMIBUILT_SSH_HOST="$ssh_host" \
    --from-literal=KIMIBUILT_SSH_PORT="$ssh_port" \
    --from-literal=KIMIBUILT_SSH_USERNAME="$ssh_username" \
    --from-literal=KIMIBUILT_SSH_PASSWORD="$ssh_password" \
    --from-literal=KIMIBUILT_SSH_KEY_PATH="$ssh_key_path" \
    --from-literal=POSTGRES_PASSWORD="$postgres_password"

  print_secret "$KIMIBUILT_NAMESPACE" kimibuilt-secrets \
    OPENAI_API_KEY N8N_API_KEY REMOTE_CLI_MCP_BEARER_TOKEN \
    OPENAI_MEDIA_API_KEY PERPLEXITY_API_KEY \
    KIMIBUILT_AUTH_USERNAME KIMIBUILT_AUTH_PASSWORD KIMIBUILT_JWT_SECRET \
    LILLYBUILT_AUTH_USERNAME LILLYBUILT_AUTH_PASSWORD LILLYBUILT_JWT_SECRET \
    KIMIBUILT_REMOTE_RUNNER_TOKEN POSTGRES_PASSWORD
}

ensure_platform_secrets() {
  local root_username root_password root_email runner_token
  local registry_host registry_username registry_password
  local build_events_url build_events_secret build_events_insecure buildkit_host

  ensure_namespace "$PLATFORM_NAMESPACE"

  root_username="$(choose_secret_value GITLAB_ROOT_USERNAME "$PLATFORM_NAMESPACE" gitlab-root username root)"
  root_password="$(choose_secret_value GITLAB_ROOT_PASSWORD "$PLATFORM_NAMESPACE" gitlab-root password)"
  root_email="$(choose_secret_value GITLAB_ROOT_EMAIL "$PLATFORM_NAMESPACE" gitlab-root email admin@demoserver2.buzz)"
  runner_token="$(choose_secret_value GITLAB_RUNNER_TOKEN "$PLATFORM_NAMESPACE" gitlab-runner runner-token replace-after-gitlab-boot)"
  registry_host="$(choose_secret_value GITLAB_REGISTRY_HOST "$PLATFORM_NAMESPACE" agent-platform-runtime gitlab-registry-host registry.gitlab.demoserver2.buzz)"
  registry_username="$(choose_secret_value GITLAB_REGISTRY_USERNAME "$PLATFORM_NAMESPACE" agent-platform-runtime gitlab-registry-username "$root_username")"
  registry_password="$(choose_secret_value GITLAB_REGISTRY_PASSWORD "$PLATFORM_NAMESPACE" agent-platform-runtime gitlab-registry-password "$root_password")"
  build_events_url="$(choose_secret_value KIMIBUILT_BUILD_EVENTS_URL "$PLATFORM_NAMESPACE" agent-platform-runtime kimibuilt-build-events-url https://kimibuilt.demoserver2.buzz/api/integrations/gitlab/build-events)"
  build_events_secret="$(choose_secret_value KIMIBUILT_BUILD_EVENTS_SECRET "$PLATFORM_NAMESPACE" agent-platform-runtime kimibuilt-build-events-secret)"
  build_events_insecure="$(choose_secret_value KIMIBUILT_BUILD_EVENTS_INSECURE "$PLATFORM_NAMESPACE" agent-platform-runtime kimibuilt-build-events-insecure 0)"
  buildkit_host="$(choose_secret_value BUILDKIT_HOST "$PLATFORM_NAMESPACE" agent-platform-runtime buildkit-host tcp://buildkitd.agent-platform.svc.cluster.local:1234)"

  echo
  echo "Ensuring ${PLATFORM_NAMESPACE}/gitlab-root, gitlab-runner, and agent-platform-runtime..."
  apply_secret gitlab-root \
    --namespace "$PLATFORM_NAMESPACE" \
    --from-literal=username="$root_username" \
    --from-literal=password="$root_password" \
    --from-literal=email="$root_email"

  apply_secret gitlab-runner \
    --namespace "$PLATFORM_NAMESPACE" \
    --from-literal=runner-token="$runner_token"

  apply_secret agent-platform-runtime \
    --namespace "$PLATFORM_NAMESPACE" \
    --from-literal=gitlab-registry-host="$registry_host" \
    --from-literal=gitlab-registry-username="$registry_username" \
    --from-literal=gitlab-registry-password="$registry_password" \
    --from-literal=kimibuilt-build-events-url="$build_events_url" \
    --from-literal=kimibuilt-build-events-secret="$build_events_secret" \
    --from-literal=kimibuilt-build-events-insecure="$build_events_insecure" \
    --from-literal=buildkit-host="$buildkit_host"

  print_secret "$PLATFORM_NAMESPACE" gitlab-root username password email
  print_secret "$PLATFORM_NAMESPACE" gitlab-runner runner-token
  print_secret "$PLATFORM_NAMESPACE" agent-platform-runtime \
    gitlab-registry-host gitlab-registry-username gitlab-registry-password \
    kimibuilt-build-events-url kimibuilt-build-events-secret \
    kimibuilt-build-events-insecure buildkit-host
}

if is_enabled "$CREATE_KIMIBUILT_SECRETS"; then
  require_cluster_access
  ensure_kimibuilt_secrets
fi

if is_enabled "$CREATE_PLATFORM_SECRETS"; then
  require_cluster_access
  ensure_platform_secrets
fi

echo
echo "Secret generation complete."
if ! is_enabled "$SHOW_SECRET_VALUES"; then
  cat <<EOF
To view decoded values in Kubernetes, rerun with:
  SHOW_SECRET_VALUES=1 $0

Or inspect directly with kubectl, for example:
  kubectl get secret kimibuilt-secrets -n ${KIMIBUILT_NAMESPACE} -o jsonpath='{.data.KIMIBUILT_AUTH_PASSWORD}' | base64 -d
  kubectl get secret gitlab-root -n ${PLATFORM_NAMESPACE} -o jsonpath='{.data.password}' | base64 -d
EOF
fi
