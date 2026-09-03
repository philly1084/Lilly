#!/usr/bin/env bash
# Stateful Codex adapter used by the nuts remote-agent session bridge.
set -euo pipefail

if [[ ${1:-} == run ]]; then shift; fi
model=''
json=0
session=''
sandbox='workspace-write'
effort=''
prompt=''
while (( $# )); do
  case "$1" in
    --format|--model|--session|--sandbox|--reasoning-effort)
      if (( $# < 2 )) || [[ -z $2 ]]; then
        printf 'codex-remote-run: %s requires a value\n' "$1" >&2
        exit 2
      fi
      case "$1" in
        --format) if [[ $2 == json ]]; then json=1; fi ;;
        --model) model=$2 ;;
        --session) session=$2 ;;
        --sandbox) sandbox=$2 ;;
        --reasoning-effort) effort=$2 ;;
      esac
      shift 2
      ;;
    --) shift; prompt="$*"; break ;;
    --*) printf 'codex-remote-run: unsupported option %s\n' "$1" >&2; exit 2 ;;
    *) if [[ -z $prompt ]]; then prompt=$1; else prompt+=" $1"; fi; shift ;;
  esac
done
case "$sandbox" in
  read-only|workspace-write|danger-full-access) ;;
  *) printf 'codex-remote-run: invalid sandbox\n' >&2; exit 2 ;;
esac
case "$effort" in
  ''|none|minimal|low|medium|high|xhigh) ;;
  *) printf 'codex-remote-run: invalid reasoning effort\n' >&2; exit 2 ;;
esac

task_tmp=$(mktemp -d -t codex-remote-run.XXXXXXXX)
cleanup() { rm -f -- "$task_tmp/stdout" "$task_tmp/stderr"; rmdir -- "$task_tmp"; }
trap cleanup EXIT

run_codex() {
  local -a command=(codex exec --skip-git-repo-check --sandbox "$sandbox")
  (( json )) && command+=(--json)
  [[ -n $model ]] && command+=(-m "$model")
  if [[ -n $effort ]]; then
    command+=(-c "model_reasoning_effort=$effort")
    # This acknowledges the CLI invocation, not unobservable model internals.
    printf 'GATEWAY_REMOTE_REASONING_EFFORT_APPLIED=%s\n' "$effort"
  fi
  [[ -n $session ]] && command+=(resume "$session")
  command+=(-- "$prompt")
  local -a statuses
  # Stream JSONL immediately. Never turn a failing Codex exit into shell success.
  if "${command[@]}" < /dev/null 2> "$task_tmp/stderr" | tee "$task_tmp/stdout"; then
    statuses=(0 0)
  else
    statuses=("${PIPESTATUS[@]}")
  fi
  cat "$task_tmp/stderr" >&2
  if (( statuses[0] != 0 )); then return "${statuses[0]}"; fi
  return "${statuses[1]}"
}

if run_codex; then
  exit 0
else
  status=$?
fi
# Preserve the existing bounded auth repair, only before observable tool work.
if grep -Eiq 'refresh_token_reused|refresh_token_invalidated|token_invalidated|token_expired|Failed to refresh token' "$task_tmp/stderr" \
  && ! grep -Eq '"type"[[:space:]]*:[[:space:]]*"(item.completed|command_execution)"' "$task_tmp/stdout" \
  && command -v codex-sync-auth-from-gateway >/dev/null 2>&1; then
  printf 'codex-remote-run: stale auth; syncing from gateway and retrying once.\n' >&2
  if codex-sync-auth-from-gateway; then
    if run_codex; then exit 0; else exit "$?"; fi
  fi
fi
exit "$status"
