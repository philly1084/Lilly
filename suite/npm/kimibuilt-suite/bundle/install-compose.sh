#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="${SCRIPT_DIR}/templates"
DEFAULT_INSTALL_ROOT="/opt/kimibuilt-suite"
DEFAULT_STATE_ROOT="/var/lib/kimibuilt-suite"
DEFAULT_PROJECT_NAME="kimibuilt-suite"

install_root="${KIMIBUILT_INSTALL_ROOT:-$DEFAULT_INSTALL_ROOT}"
state_root="${KIMIBUILT_STATE_ROOT:-$DEFAULT_STATE_ROOT}"
project_name="${COMPOSE_PROJECT_NAME:-$DEFAULT_PROJECT_NAME}"
public_origin="${KIMIBUILT_PUBLIC_ORIGIN:-http://localhost:3000}"
env_file=""
dry_run=0
yes=0
no_start=0
print_secrets=0

usage() {
  cat <<'EOF'
KimiBuilt Suite compose installer

Usage:
  install-compose.sh [options]

Options:
  --install-root <path>  Where compose.yaml and release.env are installed.
                         Default: /opt/kimibuilt-suite
  --state-root <path>    Where persistent service data is stored.
                         Default: /var/lib/kimibuilt-suite
  --env-file <path>      Existing or generated env file path.
                         Default: <install-root>/release.env
  --public-origin <url>  Online URL users will open after install.
                         Default: http://localhost:3000
  --project-name <name>  Docker Compose project name.
                         Default: kimibuilt-suite
  --yes                  Start services after preparing files.
  --no-start             Prepare files only, even with --yes.
  --print-secrets        Print generated credentials to the terminal.
  --dry-run              Print planned actions without changing files.
  --help                 Show this help.

The installer never commits secrets. It writes release.env on the target host,
generates strong passwords for GENERATE_ME_* placeholders, and prints where the
operator can retrieve them later.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

quote() {
  printf '%q' "$1"
}

random_secret() {
  local size="${1:-48}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$size" | tr -d '\r\n' | cut -c 1-"$size"
    return
  fi
  head -c "$size" /dev/urandom | base64 | tr -d '\r\n' | cut -c 1-"$size"
}

mask_value() {
  local value="${1:-}"
  if [[ -z "$value" ]]; then
    printf '<empty>'
  else
    printf '<set:%s chars>' "${#value}"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root)
      install_root="${2:-}"
      [[ -n "$install_root" ]] || die "--install-root requires a path"
      shift 2
      ;;
    --install-root=*)
      install_root="${1#*=}"
      shift
      ;;
    --state-root)
      state_root="${2:-}"
      [[ -n "$state_root" ]] || die "--state-root requires a path"
      shift 2
      ;;
    --state-root=*)
      state_root="${1#*=}"
      shift
      ;;
    --env-file)
      env_file="${2:-}"
      [[ -n "$env_file" ]] || die "--env-file requires a path"
      shift 2
      ;;
    --env-file=*)
      env_file="${1#*=}"
      shift
      ;;
    --public-origin)
      public_origin="${2:-}"
      [[ -n "$public_origin" ]] || die "--public-origin requires a URL"
      shift 2
      ;;
    --public-origin=*)
      public_origin="${1#*=}"
      shift
      ;;
    --project-name)
      project_name="${2:-}"
      [[ -n "$project_name" ]] || die "--project-name requires a value"
      shift 2
      ;;
    --project-name=*)
      project_name="${1#*=}"
      shift
      ;;
    --yes|-y)
      yes=1
      shift
      ;;
    --no-start)
      no_start=1
      shift
      ;;
    --print-secrets)
      print_secrets=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

[[ -d "$TEMPLATE_DIR" ]] || die "Missing template directory: $TEMPLATE_DIR"
[[ -f "${TEMPLATE_DIR}/release-compose.yaml" ]] || die "Missing release-compose.yaml"
[[ -f "${TEMPLATE_DIR}/release.env.example" ]] || die "Missing release.env.example"

env_file="${env_file:-${install_root}/release.env}"
compose_file="${install_root}/compose.yaml"

run() {
  if [[ "$dry_run" -eq 1 ]]; then
    printf 'DRY RUN'
    for arg in "$@"; do
      printf ' %s' "$(quote "$arg")"
    done
    printf '\n'
    return
  fi
  "$@"
}

generate_env() {
  local source="$1"
  local target="$2"
  local line key marker size value

  if [[ -f "$target" ]]; then
    echo "Keeping existing env file: $target"
    return
  fi

  if [[ "$dry_run" -eq 1 ]]; then
    echo "DRY RUN generate $target from $source"
    return
  fi

  umask 077
  : > "$target"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == *=GENERATE_ME_* ]]; then
      key="${line%%=*}"
      marker="${line#*=GENERATE_ME_}"
      size="$marker"
      [[ "$size" =~ ^[0-9]+$ ]] || size=48
      value="$(random_secret "$size")"
      printf '%s=%s\n' "$key" "$value" >> "$target"
    elif [[ "$line" == KIMIBUILT_PUBLIC_ORIGIN=* ]]; then
      printf 'KIMIBUILT_PUBLIC_ORIGIN=%s\n' "$public_origin" >> "$target"
    elif [[ "$line" == API_BASE_URL=* ]]; then
      printf 'API_BASE_URL=%s\n' "$public_origin" >> "$target"
    elif [[ "$line" == KIMIBUILT_ALLOWED_ORIGINS=* ]]; then
      printf 'KIMIBUILT_ALLOWED_ORIGINS=%s\n' "$public_origin" >> "$target"
    elif [[ "$line" == KIMIBUILT_INSTALL_ROOT=* ]]; then
      printf 'KIMIBUILT_INSTALL_ROOT=%s\n' "$install_root" >> "$target"
    elif [[ "$line" == KIMIBUILT_STATE_ROOT=* ]]; then
      printf 'KIMIBUILT_STATE_ROOT=%s\n' "$state_root" >> "$target"
    elif [[ "$line" == COMPOSE_PROJECT_NAME=* ]]; then
      printf 'COMPOSE_PROJECT_NAME=%s\n' "$project_name" >> "$target"
    else
      printf '%s\n' "$line" >> "$target"
    fi
  done < "$source"
  chmod 600 "$target"
}

env_value() {
  local key="$1"
  local file="$2"
  local value=""
  if [[ -f "$file" ]]; then
    value="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true)"
  fi
  printf '%s' "$value"
}

print_summary() {
  local username password frontend_key postgres_password jwt_secret
  username="$(env_value KIMIBUILT_AUTH_USERNAME "$env_file")"
  password="$(env_value KIMIBUILT_AUTH_PASSWORD "$env_file")"
  frontend_key="$(env_value KIMIBUILT_FRONTEND_API_KEY "$env_file")"
  postgres_password="$(env_value POSTGRES_PASSWORD "$env_file")"
  jwt_secret="$(env_value KIMIBUILT_JWT_SECRET "$env_file")"

  cat <<EOF

KimiBuilt Suite is prepared.

Install root: $install_root
State root:   $state_root
Env file:     $env_file
Compose file: $compose_file
Online URL:   $public_origin
Login user:   ${username:-admin}
Login pass:   $(mask_value "$password")
API token:    $(mask_value "$frontend_key")
Postgres:     $(mask_value "$postgres_password")
JWT secret:   $(mask_value "$jwt_secret")

EOF

  if [[ "$print_secrets" -eq 1 ]]; then
    cat <<EOF
One-time secret display:
  KIMIBUILT_AUTH_USERNAME=${username:-admin}
  KIMIBUILT_AUTH_PASSWORD=$password
  KIMIBUILT_FRONTEND_API_KEY=$frontend_key
  POSTGRES_PASSWORD=$postgres_password
  KIMIBUILT_JWT_SECRET=$jwt_secret

EOF
  else
    cat <<EOF
Secret values were saved in release.env and hidden here.
To display them intentionally:
  grep -E '^(KIMIBUILT_AUTH_USERNAME|KIMIBUILT_AUTH_PASSWORD|KIMIBUILT_FRONTEND_API_KEY|POSTGRES_PASSWORD)=' "$env_file"

EOF
  fi

  if [[ "$yes" -ne 1 || "$no_start" -eq 1 ]]; then
    cat <<EOF
To start services after reviewing release.env:
  docker compose --project-name "$project_name" --env-file "$env_file" --file "$compose_file" up -d

EOF
  fi
}

prepare_files() {
  run mkdir -p "$install_root" "$state_root" "$state_root/backend" "$state_root/postgres" "$state_root/qdrant" "$state_root/ollama"
  run cp "${TEMPLATE_DIR}/release-compose.yaml" "$compose_file"
  generate_env "${TEMPLATE_DIR}/release.env.example" "$env_file"
}

start_services() {
  if [[ "$no_start" -eq 1 ]]; then
    echo "Skipping service start because --no-start was supplied."
    return
  fi

  if [[ "$yes" -ne 1 ]]; then
    echo "Skipping service start. Re-run with --yes after reviewing release.env."
    return
  fi

  run docker compose \
    --project-name "$project_name" \
    --env-file "$env_file" \
    --file "$compose_file" \
    up -d
}

prepare_files
print_summary
start_services
