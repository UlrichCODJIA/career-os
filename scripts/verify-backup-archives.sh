#!/usr/bin/env bash
set -euo pipefail

backup_dir=${1:?Pass the exact fresh backup directory}
[[ "$backup_dir" == /home/azureuser/career-os-prechange-* && -d "$backup_dir" ]] || {
  echo "unexpected backup directory" >&2
  exit 1
}

restore_dir=$(mktemp -d /home/azureuser/career-os-artifact-restore-XXXXXXXX)
[[ "$restore_dir" == /home/azureuser/career-os-artifact-restore-* ]] || exit 1
trap 'rm -rf -- "$restore_dir"' EXIT

zstd -dc "$backup_dir/artifacts.tar.zst" | tar -C "$restore_dir" -xf -
cd -- "$restore_dir"
test -d sha256
find sha256 -type f -exec sha256sum {} + |
  awk '{ count++; n = split($2, path, "/"); if ($1 != path[n]) bad++ }
       END { printf "restored_artifacts=%d digest_mismatches=%d\n", count, bad;
             if (count == 0 || bad) exit 1 }'

zstd -dc "$backup_dir/private-config.tar.zst" | tar -tf - >/dev/null
zstd -dc "$backup_dir/release-evidence.tar.zst" | tar -tf - >/dev/null
echo "other_archives_readable=yes"
