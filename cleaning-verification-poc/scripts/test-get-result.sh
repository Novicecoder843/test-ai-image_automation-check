#!/usr/bin/env bash
# Fetch the latest verification result for a task.
# Usage:  ./scripts/test-get-result.sh <task_id> [--history]
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
TASK_ID="${1:?task_id required}"
HISTORY="${2:-}"

URL="$BASE_URL/api/tasks/$TASK_ID/result"
if [[ "$HISTORY" == "--history" ]]; then URL="${URL}?includeHistory=true"; fi

echo "GET $URL"
curl -sS "$URL" | python3 -m json.tool
