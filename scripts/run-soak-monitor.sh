#!/usr/bin/env bash
set -euo pipefail

: "${CAREER_OS_DEPLOY_DIR:?Set CAREER_OS_DEPLOY_DIR to the deployed release directory}"
cd -- "$CAREER_OS_DEPLOY_DIR"
test -f compose.yaml && test -f compose.soak.yaml || {
  echo "the verified VM Compose files are missing from the deployed release" >&2
  exit 1
}
compose=(sudo -n docker compose --project-directory "$CAREER_OS_DEPLOY_DIR" \
  -f "$CAREER_OS_DEPLOY_DIR/compose.yaml" -f "$CAREER_OS_DEPLOY_DIR/compose.soak.yaml" --profile local)

if [[ -z "${SOAK_STARTED_AT:-}" ]]; then
  # A pre-soak check is read-only. It never writes a snapshot or starts a timer.
  "${compose[@]}" run --rm --no-deps -T worker bun run release:inspect-soak
else
  : "${RELEASE_COMMIT:?RELEASE_COMMIT is required after the soak starts}"
  : "${REGISTRY_DIGEST:?REGISTRY_DIGEST is required after the soak starts}"
  # The worker service already has private database access and the evidence volume.
  "${compose[@]}" run --rm --no-deps -T \
    -e "SOAK_STARTED_AT=$SOAK_STARTED_AT" -e "RELEASE_COMMIT=$RELEASE_COMMIT" \
    -e "REGISTRY_DIGEST=$REGISTRY_DIGEST" \
    worker bun run release:capture-soak
fi
