#!/bin/sh
set -eu
curl -fsS \
  -H "Authorization: Bearer ${FRONTEND_API_KEY}" \
  "http://127.0.0.1:3000/api/tools/available?includeAll=true" \
  | grep -o '"id":"remote-command"[^}]*\|"id":"remote-workbench"[^}]*\|"id":"remote-cli-agent"[^}]*\|"id":"k3s-deploy"[^}]*' \
  | head -n 20
