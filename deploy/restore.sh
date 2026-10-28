#!/usr/bin/env bash
# Restore a backup folder made by backup.sh: the history and the captured text are replaced by the folder's.
#
#   restore.sh [--yes] <dated folder>   e.g. restore.sh ~/agent-orb-backups/2026-10-24
#
# It stops orb-server, puts history.db and content.db from the folder back into the server's volume (dropping the old files'
# -wal and -shm, which must never be replayed onto the restored ones), then starts orb-server.
# It asks first, unless --yes. The settings are backup.sh's: ORB_COMPOSE_FILE, ORB_COMPOSE_PROJECT.
# It never pulls or builds an image: the copy runs from the image of the stack's own container.
set -euo pipefail

# shellcheck source=backup.sh
. "$(dirname "${BASH_SOURCE[0]}")/backup.sh" # the settings, dc(), oneoff(), die() and usage(); backup.sh does nothing when sourced

yes=0
dir=
for a in "$@"; do
  case $a in
    --yes) yes=1 ;;
    -*) usage ;;
    *) dir=$a ;;
  esac
done
[ -n "$dir" ] || usage
[ -d "$dir" ] || die "$dir is not a folder"
if [ ! -f "$dir/history.db" ] || [ ! -f "$dir/content.db" ]; then
  more=
  if [ -f "$dir/neo4j.dump" ]; then more=". It holds neo4j.dump, a backup of v0.2's Neo4j graph, which this version cannot restore"; fi
  die "$dir does not hold both history.db and content.db, so it is not a backup this version made$more"
fi
dir=$(cd "$dir" && pwd) # docker reads a relative path as a volume name

if [ "$yes" = 0 ]; then
  printf 'This replaces the current history and captured text with %s. Continue? [y/N] ' "$dir" >&2
  read -r answer || answer=
  case $answer in y | Y | yes) ;; *) echo "restore: cancelled, nothing was changed" >&2; exit 1 ;; esac
fi

trap '[ $? = 0 ] || echo "restore: failed. Nothing was started again, so orb-server may be stopped; the backup folder is untouched. Run it again once the cause is fixed." >&2' EXIT

dc stop orb-server

# Copy beside each old file and rename, and drop the old file's WAL so it is never replayed onto the new one.
oneoff orb-server -v "$dir:/backups" --entrypoint sh -- -c '
  set -e
  d=/var/lib/agent-orb
  for f in history.db content.db; do
    cp /backups/$f "$d/$f.restoring"
    rm -f "$d/$f-wal" "$d/$f-shm"
    mv "$d/$f.restoring" "$d/$f"
  done'

dc start orb-server
trap - EXIT
echo "restored $dir. The studio is back in a few seconds."
