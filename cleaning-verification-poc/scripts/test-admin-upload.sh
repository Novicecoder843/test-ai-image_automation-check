#!/usr/bin/env bash
# Upload a reference image for a facility.
# Usage:  ./scripts/test-admin-upload.sh <facility_id> <path/to/image.jpg> [template_id] [label]
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
FACILITY_ID="${1:?facility_id required}"
IMAGE_PATH="${2:?image path required}"
TEMPLATE_ID="${3:-}"
LABEL="${4:-}"

ARGS=(-X POST "$BASE_URL/api/admin/upload-reference"
      -F "image=@${IMAGE_PATH}"
      -F "facility_id=${FACILITY_ID}")

if [[ -n "$TEMPLATE_ID" ]]; then ARGS+=(-F "template_id=${TEMPLATE_ID}"); fi
if [[ -n "$LABEL"       ]]; then ARGS+=(-F "label=${LABEL}");             fi

echo "POST $BASE_URL/api/admin/upload-reference"
curl -sS "${ARGS[@]}" | tee /tmp/upload-reference.json | python3 -m json.tool
