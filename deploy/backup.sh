#!/usr/bin/env bash
# The nightly backup of the agent-orb stack (PROJECT.md §10): the history (history.db) and the captured text (content.db),
# each copied with VACUUM INTO while the server runs, and the newest ORB_BACKUP_KEEP dated folders kept.
#
#   backup.sh [run]                 back up now, then prune
#   backup.sh prune                 keep the newest ORB_BACKUP_KEEP folders named YYYY-MM-DD, delete older ones
#   backup.sh install [--dry-run]   schedule it daily at 03:30: launchd on macOS, a crontab line to add on Linux
#   backup.sh uninstall             undo install (on Linux: say what to remove)
#
# Settings, by environment variable:
#   ORB_COMPOSE_FILE     the stack's compose file          (default: docker-compose.yml beside this script)
#   ORB_COMPOSE_PROJECT  its compose project name          (default: the name the file gives itself)
#   ORB_BACKUP_DIR       where the dated folders go        (default: $HOME/agent-orb-backups)
#   ORB_BACKUP_KEEP      how many dated folders to keep    (default: 7)
#
# Needs bash 3.2 (macOS's own) and Docker Compose v2. On Linux the one-off container writes as its own user
# (node), so ORB_BACKUP_DIR may need to be writable for it: best effort, not tried here.
# It never pulls or builds an image: every one-off runs from the image of the stack's own container, so start the stack once.
set -euo pipefail

# restore.sh sources this file for the settings, dc() and oneoff(); the case at the bottom only acts when it is run directly.

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
self=$here/$(basename "${BASH_SOURCE[0]}")
ORB_COMPOSE_FILE=${ORB_COMPOSE_FILE:-$here/docker-compose.yml}
ORB_COMPOSE_PROJECT=${ORB_COMPOSE_PROJECT:-}
ORB_BACKUP_DIR=${ORB_BACKUP_DIR:-$HOME/agent-orb-backups}
ORB_BACKUP_KEEP=${ORB_BACKUP_KEEP:-7}
label=dev.agent-orb.backup

die() { echo "$(basename "$0" .sh): $*" >&2; exit 1; }
usage() { sed -n '2,/^set /{/^set /!p;}' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; } # the header of whichever script is running
abs() { case $1 in /*) printf '%s\n' "$1" ;; *) printf '%s\n' "$PWD/$1" ;; esac; }

# Every compose call goes through here, so a drill can point the scripts at a throwaway project.
dc() {
  if [ -n "$ORB_COMPOSE_PROJECT" ]; then
    docker compose -f "$ORB_COMPOSE_FILE" -p "$ORB_COMPOSE_PROJECT" "$@"
  else
    docker compose -f "$ORB_COMPOSE_FILE" "$@"
  fi
}

# The first container of a service, running or stopped; empty when the stack never created one.
cid() { dc ps -aq "$1" | head -n 1; }

# A one-off in the image and volumes of a service's own container, so nothing is pulled or built: `docker compose run`
# would take the compose file's current image, which may not be on this machine.
#   oneoff <service> [docker run options...] -- <command...>
# The one-off gets the container's volumes and image but not its environment, which a snapshot or a copy does not need.
oneoff() {
  local svc=$1 id img opts
  opts=()
  shift
  while [ "$1" != -- ]; do opts+=("$1"); shift; done
  shift
  id=$(cid "$svc") || return
  if [ -z "$id" ]; then
    echo "$(basename "$0" .sh): the stack has no $svc container: start it once with docker compose up -d" >&2
    return 1
  fi
  img=$(docker inspect --format '{{.Image}}' "$id") || return
  docker run --rm --volumes-from "$id" ${opts[@]+"${opts[@]}"} "$img" "$@"
}

# The JS that writes a snapshot of each of the volume's two SQLite files to $1<name>. VACUUM INTO is a consistent snapshot while the server runs.
# Exit 3 tells "the server has not made its files yet" from a real failure: it creates both when it starts.
# The heredoc is unquoted for $1: keep $, backtick and backslash out of it.
snapshot_js() {
  cat <<JS
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const from = "/var/lib/agent-orb/", to = "$1", names = ["history.db", "content.db"];
for (const f of names) if (!fs.existsSync(from + f)) { console.error(f + " is not in the volume yet"); process.exit(3); }
for (const f of names) new DatabaseSync(from + f).exec("VACUUM INTO '" + to + f + "'");
JS
}

# The files while orb-server runs: the snapshots are taken inside its container, copied out, and removed from its volume.
snapshot_live() {
  local tmp=/var/lib/agent-orb/.backup- rc=0
  dc exec -T orb-server rm -f "${tmp}history.db" "${tmp}content.db" || return $? # left by a run that was killed: VACUUM INTO refuses a file that exists
  dc exec -T -e NODE_NO_WARNINGS=1 orb-server node -e "$(snapshot_js "$tmp")" || rc=$? # the flag silences node:sqlite's experimental warning
  if [ "$rc" -eq 0 ]; then
    dc cp "orb-server:${tmp}history.db" "$partial/history.db" || rc=$?
    dc cp "orb-server:${tmp}content.db" "$partial/content.db" || rc=$?
  fi
  if [ "$rc" -ne 3 ]; then dc exec -T orb-server rm -f "${tmp}history.db" "${tmp}content.db" || true; fi # best effort, the next run removes a leftover
  return "$rc"
}

check_keep() {
  case $ORB_BACKUP_KEEP in '' | *[!0-9]*) die "ORB_BACKUP_KEEP must be a whole number, not '$ORB_BACKUP_KEEP'" ;; esac
  [ "$ORB_BACKUP_KEEP" -ge 1 ] || die "ORB_BACKUP_KEEP must be at least 1"
}

# Keep the newest ORB_BACKUP_KEEP folders named exactly YYYY-MM-DD (by name, not by mtime); nothing else is touched.
prune() {
  check_keep
  [ -d "$ORB_BACKUP_DIR" ] || return 0
  local p total=0 drop
  for p in "$ORB_BACKUP_DIR"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
    if [ -d "$p" ] && [ ! -L "$p" ]; then total=$((total + 1)); fi
  done
  drop=$((total - ORB_BACKUP_KEEP))
  for p in "$ORB_BACKUP_DIR"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do # the glob sorts oldest first
    [ "$drop" -gt 0 ] || break
    if [ -d "$p" ] && [ ! -L "$p" ]; then
      rm -rf -- "$p"
      echo "pruned $p"
      drop=$((drop - 1))
    fi
  done
}

# A global, not a local: the EXIT trap reads it.
partial=
finish() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$rc" -ne 0 ]; then
    [ -z "$partial" ] || rm -rf "$partial"
    echo "backup: failed (exit $rc)" >&2
  fi
  exit "$rc"
}

size() { du -h "$1" | awk '{print $1}'; }

run() {
  command -v docker >/dev/null || die "docker is not on PATH"
  check_keep # before anything is done, not after the backup is published
  local day final old rc=0
  day=$(date +%F)
  final=$ORB_BACKUP_DIR/$day
  mkdir -p "$ORB_BACKUP_DIR"
  partial=$ORB_BACKUP_DIR/.partial-$day
  trap finish EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  rm -rf "$partial" # left by a run that was killed today
  mkdir "$partial"

  # 1. Both files, with the stack as it is: inside orb-server's container when it runs, from its image when it is stopped. Nothing is stopped for it.
  if [ -n "$(dc ps -q --status running orb-server)" ]; then
    snapshot_live || rc=$?
  else
    oneoff orb-server -e NODE_NO_WARNINGS=1 -v "$partial:/backups" --entrypoint node -- -e "$(snapshot_js /backups/)" || rc=$? # says so itself when the stack has no such container
  fi
  case $rc in
    0) ;;
    3) echo "backup: the server has not made its files yet, so there is nothing to back up: start it once with docker compose up -d" >&2; exit 1 ;;
    *) exit "$rc" ;;
  esac
  [ -s "$partial/history.db" ] && [ -s "$partial/content.db" ] || die "the snapshot left no history.db and content.db in $partial, nothing is published"

  # 2. Publish: a second run today replaces that day's folder only now, with the new one complete.
  if [ -e "$final" ]; then
    old=$ORB_BACKUP_DIR/.old-$day
    rm -rf "$old"
    mv "$final" "$old"
    mv "$partial" "$final" || { mv "$old" "$final"; exit 1; }
    rm -rf "$old"
  else
    mv "$partial" "$final"
  fi
  partial=

  prune

  echo "backup $day: $final, history.db $(size "$final/history.db"), content.db $(size "$final/content.db")"
}

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

plist() {
  local agent_path=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
  case ":$agent_path:" in *":$docker_dir:"*) ;; *) agent_path=$docker_dir:$agent_path ;; esac # docker's directory only when it is not in the list yet
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(xml "$self")</string><string>run</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ORB_COMPOSE_FILE</key><string>$(xml "$ORB_COMPOSE_FILE")</string>
    <key>ORB_COMPOSE_PROJECT</key><string>$(xml "$ORB_COMPOSE_PROJECT")</string>
    <key>ORB_BACKUP_DIR</key><string>$(xml "$ORB_BACKUP_DIR")</string>
    <key>ORB_BACKUP_KEEP</key><string>$(xml "$ORB_BACKUP_KEEP")</string>
    <key>PATH</key><string>$(xml "$agent_path")</string>
  </dict>
  <key>StandardOutPath</key><string>$(xml "$ORB_BACKUP_DIR/backup.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$ORB_BACKUP_DIR/backup.log")</string>
</dict>
</plist>
EOF
}

install() {
  local dry=0 agent uid docker_bin docker_dir env=
  case "${1:-}" in --dry-run) dry=1 ;; '') ;; *) usage ;; esac
  ORB_COMPOSE_FILE=$(abs "$ORB_COMPOSE_FILE")
  ORB_BACKUP_DIR=$(abs "$ORB_BACKUP_DIR")
  if [ "$(uname)" = Darwin ]; then
    # launchd's PATH lacks the directory of docker, so the job gets the one found now.
    docker_bin=$(command -v docker) || die "docker is not on PATH"
    docker_dir=$(dirname "$docker_bin")
    agent=$HOME/Library/LaunchAgents/$label.plist
    uid=$(id -u)
    if [ "$dry" = 1 ]; then
      echo "# dry run, nothing is written. It would write $agent:"
      plist
      echo "# and load it with: launchctl bootstrap gui/$uid $agent"
      return 0
    fi
    mkdir -p "$ORB_BACKUP_DIR" "$(dirname "$agent")" # launchd will not create the log's folder
    plist >"$agent"
    launchctl bootout "gui/$uid/$label" 2>/dev/null || true # a no-op when it was not loaded
    launchctl bootstrap "gui/$uid" "$agent"
    echo "installed $agent: daily at 03:30, log in $ORB_BACKUP_DIR/backup.log"
  else
    # cron has no settings of its own: the ones that are not the defaults ride on the line.
    [ "$ORB_COMPOSE_FILE" = "$here/docker-compose.yml" ] || env="${env}ORB_COMPOSE_FILE=$(printf %q "$ORB_COMPOSE_FILE") "
    [ -z "$ORB_COMPOSE_PROJECT" ] || env="${env}ORB_COMPOSE_PROJECT=$(printf %q "$ORB_COMPOSE_PROJECT") "
    [ "$ORB_BACKUP_DIR" = "$HOME/agent-orb-backups" ] || env="${env}ORB_BACKUP_DIR=$(printf %q "$ORB_BACKUP_DIR") "
    [ "$ORB_BACKUP_KEEP" = 7 ] || env="${env}ORB_BACKUP_KEEP=$ORB_BACKUP_KEEP "
    echo "Nothing was changed. To schedule the backup daily at 03:30, create the log's folder and add this line with crontab -e:"
    echo
    echo "  mkdir -p $(printf %q "$ORB_BACKUP_DIR")"
    echo "  30 3 * * * $env$(printf %q "$self") run >> $(printf %q "$ORB_BACKUP_DIR/backup.log") 2>&1"
    echo
    echo "Docker must be on cron's PATH (usually /usr/bin) and running at that hour."
  fi
}

uninstall() {
  local agent=$HOME/Library/LaunchAgents/$label.plist
  if [ "$(uname)" = Darwin ]; then
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$agent"
    echo "removed $agent. The backups in $ORB_BACKUP_DIR are kept."
  else
    echo "Nothing was changed. Remove the line that runs $self from your crontab (crontab -e)."
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-run}" in
    run) run ;;
    prune) prune ;;
    install) install "${2:-}" ;;
    uninstall) uninstall ;;
    *) usage ;;
  esac
fi
