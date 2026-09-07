#!/usr/bin/env bash
# Trigger a Render deploy pinned to an immutable image tag, then wait for it.
#
# Render's blueprint carries a floating `:main` tag as a bootstrap value; every
# CI deploy overrides it with the commit SHA so deploys are immutable and a
# rollback is just a redeploy of an older SHA.
set -euo pipefail

: "${RENDER_API_KEY:?RENDER_API_KEY is required}"
: "${SERVICE_ID:?SERVICE_ID is required}"
: "${IMAGE:?IMAGE is required}"

api() {
  curl -sS --fail-with-body \
    -H "Authorization: Bearer ${RENDER_API_KEY}" \
    -H "Content-Type: application/json" \
    "$@"
}

echo "Deploying ${IMAGE} to service ${SERVICE_ID}"

deploy_id=$(
  api -X POST "https://api.render.com/v1/services/${SERVICE_ID}/deploys" \
    -d "{\"imageUrl\":\"${IMAGE}\"}" | jq -r '.id // empty'
)

if [ -z "${deploy_id}" ]; then
  echo "::error::Render did not return a deploy id"
  exit 1
fi
echo "Created deploy ${deploy_id}"

# Render applies the new image before reporting `live`; the web service also
# runs prisma migrate deploy on boot, so allow a generous window.
for _ in $(seq 1 120); do
  sleep 15
  status=$(
    api "https://api.render.com/v1/services/${SERVICE_ID}/deploys/${deploy_id}" \
      | jq -r '.status // "unknown"'
  )
  echo "  status: ${status}"
  case "${status}" in
    live)
      echo "Deploy ${deploy_id} is live"
      exit 0
      ;;
    build_failed|update_failed|pre_deploy_failed|canceled|deactivated)
      echo "::error::Render deploy ${deploy_id} finished as ${status}"
      exit 1
      ;;
  esac
done

echo "::error::Timed out after 30m waiting for deploy ${deploy_id}"
exit 1
