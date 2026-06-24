#!/usr/bin/env bash
# Upload a janitor completion image (kicks off the AI worker).
# Usage:  ./scripts/test-janitor-upload.sh <task_id> <facility_id> <path/to/image.jpg> [template_id] [janitor_id]
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
TASK_ID="${1:?task_id required}"
FACILITY_ID="${2:?facility_id required}"
IMAGE_PATH="${3:?image path required}"
TEMPLATE_ID="${4:-}"
JANITOR_ID="${5:-}"

ARGS=(-X POST "$BASE_URL/api/janitor/upload-completion"
      -F "image=@${IMAGE_PATH}"
      -F "task_id=${TASK_ID}"
      -F "facility_id=${FACILITY_ID}")

if [[ -n "$TEMPLATE_ID" ]]; then ARGS+=(-F "template_id=${TEMPLATE_ID}"); fi
if [[ -n "$JANITOR_ID"  ]]; then ARGS+=(-F "janitor_id=${JANITOR_ID}");   fi

echo "POST $BASE_URL/api/janitor/upload-completion"
curl -sS "${ARGS[@]}" | tee /tmp/upload-completion.json | python3 -m json.tool
