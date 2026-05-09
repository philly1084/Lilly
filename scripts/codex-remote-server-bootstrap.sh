#!/usr/bin/env sh
set -eu

CODEX_TARGET_USER="${CODEX_USER:-${USER:-root}}"
CODEX_PUBLIC_KEY="${CODEX_PUBLIC_KEY:-}"
CODEX_ALLOW_IP="${CODEX_ALLOW_IP:-}"
TAILSCALE_AUTH_KEY="${TAILSCALE_AUTH_KEY:-}"
TAILSCALE_HOSTNAME="${TAILSCALE_HOSTNAME:-}"
CODEX_ONBOARD_PHRASE="${CODEX_ONBOARD_PHRASE:-}"

if [ -z "$CODEX_PUBLIC_KEY" ]; then
  echo "CODEX_PUBLIC_KEY is required." >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ] && [ "$CODEX_TARGET_USER" != "root" ]; then
  if ! id "$CODEX_TARGET_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$CODEX_TARGET_USER"
  fi
  USER_HOME="$(getent passwd "$CODEX_TARGET_USER" | cut -d: -f6)"
else
  USER_HOME="${HOME:-/root}"
fi

mkdir -p "$USER_HOME/.ssh"
chmod 700 "$USER_HOME/.ssh"
touch "$USER_HOME/.ssh/authorized_keys"
if ! grep -qxF "$CODEX_PUBLIC_KEY" "$USER_HOME/.ssh/authorized_keys"; then
  printf '%s\n' "$CODEX_PUBLIC_KEY" >> "$USER_HOME/.ssh/authorized_keys"
fi
chmod 600 "$USER_HOME/.ssh/authorized_keys"

if [ "$(id -u)" -eq 0 ]; then
  chown -R "$CODEX_TARGET_USER:$CODEX_TARGET_USER" "$USER_HOME/.ssh" 2>/dev/null || true
fi

if [ -n "$CODEX_ONBOARD_PHRASE" ]; then
  printf '%s\n' "$CODEX_ONBOARD_PHRASE" > "$USER_HOME/.ssh/codex_onboard_phrase"
  chmod 600 "$USER_HOME/.ssh/codex_onboard_phrase"
  if [ "$(id -u)" -eq 0 ]; then
    chown "$CODEX_TARGET_USER:$CODEX_TARGET_USER" "$USER_HOME/.ssh/codex_onboard_phrase" 2>/dev/null || true
  fi
fi

if [ -n "$CODEX_ALLOW_IP" ] && command -v ufw >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
  ufw allow from "$CODEX_ALLOW_IP" to any port 22 proto tcp || true
fi

if [ -n "$TAILSCALE_AUTH_KEY" ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL https://tailscale.com/install.sh | sh
    else
      echo "curl is required to install Tailscale automatically." >&2
      exit 1
    fi
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now tailscaled || true
  fi
  if [ -n "$TAILSCALE_HOSTNAME" ]; then
    tailscale up --auth-key "$TAILSCALE_AUTH_KEY" --hostname "$TAILSCALE_HOSTNAME" --ssh
  else
    tailscale up --auth-key "$TAILSCALE_AUTH_KEY" --ssh
  fi
fi

echo "Codex remote access bootstrap complete for user $CODEX_TARGET_USER."
if [ -n "$CODEX_ONBOARD_PHRASE" ]; then
  echo "Codex onboard phrase: $CODEX_ONBOARD_PHRASE"
fi
