#!/usr/bin/env bash
# Copies tara-agent's daily database backups (host `backup.dir`) to this machine, so a failing disk on the
# agent's host doesn't take the copies with it. Run it daily (cron, a systemd timer, or launchd on a Mac).
#
#   deploy/pull-backups.sh <ssh host> [remote dir] [local dir] [days to keep]
#
# The remote folder belongs to the tara-agent user (mode 700), so it is read with `sudo -n rsync` there:
# the ssh user needs passwordless sudo for rsync. Local copies older than [days to keep] are deleted.
set -euo pipefail

HOST=${1:?usage: pull-backups.sh <ssh host> [remote dir] [local dir] [days to keep]}
REMOTE=${2:-/var/lib/tara-agent/state/backups}
LOCAL=${3:-$HOME/Backups/tara-agent}
KEEP=${4:-30}

mkdir -p "$LOCAL"
chmod 700 "$LOCAL"
rsync -rt --rsync-path="sudo -n rsync" --include='tara-*.db' --exclude='*' "$HOST:$REMOTE/" "$LOCAL/"
find "$LOCAL" -name 'tara-*.db' -mtime +"$KEEP" -delete
count=$(find "$LOCAL" -name 'tara-*.db' | wc -l | tr -d ' ')
latest=$(ls -1 "$LOCAL"/tara-*.db 2>/dev/null | tail -1)
echo "$(date '+%F %T') $count copies in $LOCAL, latest $(basename "${latest:-none}")"
