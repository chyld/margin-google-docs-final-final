#!/usr/bin/env bash
# Browser checks. Each suite gets its own fresh throwaway Margin on port 5557 (never 5555).
#   e2e/run.sh all              build once, run every suite
#   e2e/run.sh core styles      build once, run the named suites
# Needs Chromium at /usr/bin/chromium (or set CHROMIUM). Screenshots go to $MARGIN_SHOTS.
set -uo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
PORT=5557
DATA=${TMPDIR:-/tmp}/m-e2e-$PORT
SUITES=(core content accounts styles continuation tags format-panel)
[ "$#" -eq 0 ] && { echo "usage: e2e/run.sh all | <suite>..."; echo "suites: ${SUITES[*]}"; exit 2; }
[ "$1" = all ] && set -- "${SUITES[@]}"

stop() {
  for pid in $(pgrep -f "node server/index.ts" || true); do
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "DATA_DIR=$DATA" && kill "$pid"
  done
  sleep 0.3
}
trap stop EXIT

npm run build --silent >/dev/null || { echo "build failed"; exit 1; }
failed=0
for suite in "$@"; do
  [ -f "e2e/$suite.mjs" ] || { echo "$suite: no such suite"; failed=1; continue; }
  stop
  rm -rf "$DATA" && mkdir -p "$DATA"
  DATA_DIR=$DATA node server/cli.ts add e2e --password-stdin <<< 'e2e-password-123' >/dev/null
  (HOST=127.0.0.1 PORT=$PORT PUBLIC_PORT=$PORT DATA_DIR=$DATA STATIC_DIR=dist/web nohup node server/index.ts > "$DATA.log" 2>&1 &)
  for _ in $(seq 1 40); do curl -sf -H "Host: localhost:$PORT" "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.25; done
  out=$(MARGIN_URL=http://localhost:$PORT MARGIN_DATA=$DATA MARGIN_NETWORK_FONTS=1 timeout 600 node "e2e/$suite.mjs" 2>&1)
  summary=$(grep -E 'checks passed|checks failed' <<< "$out" | tail -1)
  if grep -qE '^FAIL' <<< "$out" || [ -z "$summary" ]; then
    failed=1; echo "$suite: FAILED"; grep -E '^FAIL|Error' <<< "$out" | head -8; [ -n "$summary" ] && echo "  $summary"
  else
    echo "$suite: $summary"
  fi
done
exit $failed
