#!/usr/bin/env bash
# Poll the result endpoint until status is no longer PENDING/PROCESSING.
# Usage:  ./scripts/poll-result.sh <task_id> [max_seconds]
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
TASK_ID="${1:?task_id required}"
MAX_SECS="${2:-60}"

DEADLINE=$(( $(date +%s) + MAX_SECS ))
echo "Polling /api/tasks/$TASK_ID/result for up to ${MAX_SECS}s..."

while true; do
  RESP=$(curl -sS "$BASE_URL/api/tasks/$TASK_ID/result" || echo '{}')
  STATUS=$(echo "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("results",{}).get("status","?"))' 2>/dev/null || echo "?")
  echo "  status=$STATUS"
  if [[ "$STATUS" != "PENDING" && "$STATUS" != "PROCESSING" && "$STATUS" != "?" ]]; then
    echo "$RESP" | python3 -m json.tool
    exit 0
  fi
  if [[ $(date +%s) -ge $DEADLINE ]]; then
    echo "Timed out waiting for completion. Latest response:"
    echo "$RESP" | python3 -m json.tool
    exit 1
  fi
  sleep 2
done
