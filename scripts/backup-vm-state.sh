#!/usr/bin/env bash
set -euo pipefail

# Run on the approved Career OS VM before changing its deployment. The resulting
# directory is intentionally private and must be transferred directly to an
# operator-controlled machine, then restore-tested before deployment.
deploy_dir=/opt/career-os
compose=(sudo -n docker compose --project-directory "$deploy_dir" \
  -f "$deploy_dir/compose.yaml" -f "$deploy_dir/compose.soak.yaml" --profile local)

[[ -f "$deploy_dir/compose.yaml" && -f "$deploy_dir/compose.soak.yaml" ]] || {
  echo "Career OS Compose files are missing" >&2
  exit 1
}
sudo -n docker volume inspect career-os_artifacts career-os_release-evidence >/dev/null
worker_id=$("${compose[@]}" ps -q worker)
[[ -n "$worker_id" && "$(sudo -n docker inspect -f '{{.State.Running}}' "$worker_id")" == true ]] || {
  echo "Career OS worker is not running; stop and investigate" >&2
  exit 1
}

backup_dir=$(mktemp -d /home/azureuser/career-os-prechange-XXXXXXXX)
chmod 700 "$backup_dir"
worker_stopped=false
restart_worker() {
  if [[ "$worker_stopped" == true ]]; then
    # Restore the exact previously running container. Compose may refuse a
    # dependency-checked start if its one-shot migrate image is stale.
    sudo -n docker start "$worker_id" >&2
  fi
}
trap restart_worker EXIT

"${compose[@]}" stop worker >&2
worker_stopped=true
sudo -n docker exec career-os-postgres-1 pg_dump -U career_os -d career_os -Fc > "$backup_dir/career-os.dump"
sudo -n docker run --rm --network none --entrypoint tar \
  -v career-os_artifacts:/data:ro career-os-worker -C /data -cf - . \
  | zstd -q -T0 -o "$backup_dir/artifacts.tar.zst"
sudo -n docker run --rm --network none --entrypoint tar \
  -v career-os_release-evidence:/data:ro career-os-worker -C /data -cf - . \
  | zstd -q -T0 -o "$backup_dir/release-evidence.tar.zst"
sudo -n tar -C "$deploy_dir" -cf - private .env compose.soak.yaml \
  | zstd -q -T0 -o "$backup_dir/private-config.tar.zst"
sudo -n docker exec -i career-os-postgres-1 pg_restore --list \
  < "$backup_dir/career-os.dump" >/dev/null
zstd -q -t "$backup_dir/artifacts.tar.zst" "$backup_dir/release-evidence.tar.zst" \
  "$backup_dir/private-config.tar.zst"
sha256sum "$backup_dir"/{career-os.dump,artifacts.tar.zst,release-evidence.tar.zst,private-config.tar.zst}
echo "BACKUP_DIR=$backup_dir"
