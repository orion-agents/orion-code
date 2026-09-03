#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_BRANCH="${QUALITY_REVIEW_BRANCH:-v0.3.1}"
CHECK_COMMAND="${QUALITY_REVIEW_COMMAND:-npm run lint && npm run test -- --runInBand}"
NODE_BIN="${QUALITY_REVIEW_NODE_BIN:-}"
LOG_FILE="${QUALITY_REVIEW_LOG:-$HOME/Library/Logs/orion-quality-review.log}"
RUN_INTERVAL_SECONDS="${QUALITY_REVIEW_INTERVAL_SECONDS:-1800}"
REMOTE_NAME="${QUALITY_REVIEW_REMOTE:-origin}"
MODE="${1:-once}"
STATE_DIR="${QUALITY_REVIEW_STATE_DIR:-$REPO_ROOT/.quality-review}"
LOCK_DIR="$STATE_DIR/.lock"

mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$STATE_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  printf '%s [orion-quality-review] skip: another run is in progress.\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" | tee -a "$LOG_FILE"
  exit 0
fi

trap 'rm -rf "$LOCK_DIR"' EXIT

log() {
  printf '%s [orion-quality-review] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$1" | tee -a "$LOG_FILE"
}

run_once() {
  cd "$REPO_ROOT"

  local review_command="$CHECK_COMMAND"
  if [[ -n "$NODE_BIN" ]]; then
    if [[ ! -x "$NODE_BIN/node" || ! -x "$NODE_BIN/npm" ]]; then
      log "Quality Node bin is invalid: $NODE_BIN"
      return 1
    fi
    review_command="export PATH=$(printf '%q' "$NODE_BIN"):\$PATH; $CHECK_COMMAND"
  fi

  log "Start review cycle on $(git rev-parse --abbrev-ref HEAD) (target: $TARGET_BRANCH)"

  local current_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$current_branch" != "$TARGET_BRANCH" ]]; then
    log "Skip cycle: current branch $current_branch does not match target $TARGET_BRANCH"
    return 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    log "Worktree has local changes; skipping pull."
  elif ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
    log "Remote '$REMOTE_NAME' not configured; skipping pull."
  elif ! git ls-remote --exit-code --heads "$REMOTE_NAME" "$TARGET_BRANCH" >/dev/null 2>&1; then
    log "Remote '$REMOTE_NAME' has no branch $TARGET_BRANCH; skipping pull."
  elif ! git pull --ff-only "$REMOTE_NAME" "$TARGET_BRANCH" >>"$LOG_FILE" 2>&1; then
    log "Warning: git pull --ff-only failed; continuing with local branch state."
  fi

  if bash -lc "$review_command" >>"$LOG_FILE" 2>&1; then
    log "Quality command succeeded: $CHECK_COMMAND"
    date '+%Y-%m-%dT%H:%M:%S%z' > "$STATE_DIR/last-pass.txt"
    return 0
  fi

  log "Quality command failed: $CHECK_COMMAND"
  date '+%Y-%m-%dT%H:%M:%S%z' > "$STATE_DIR/last-fail.txt"
  return 1
}

if [[ "$MODE" == "--loop" ]]; then
  while true; do
    run_once || true
    sleep "$RUN_INTERVAL_SECONDS"
  done
else
  run_once
fi
