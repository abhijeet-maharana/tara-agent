#!/usr/bin/env bash
# Restore test for tara-backup: proves the newest off-site copy can really be brought back. Run it on a
# machine that has the age private key (never on the backed-up host), monthly (launchd/cron, see
# deploy/backup/restore-test.plist):
#
#   deploy/backup/restore-test.sh <ssh host> [age key file]
#
# 1. asks the host for a one-hour download link to its newest good archive (`tara-backup presign`, via
#    `sudo -n`, so the ssh user needs passwordless sudo for /usr/local/sbin/tara-backup)
# 2. downloads it straight from the store, checks its sha256, decrypts it with the key, unpacks it
# 3. checks every database (integrity_check, row counts) and file against the manifest (`verify`)
# 4. records the result on the host (`tara-backup restore-result`), where the Health page shows it
# The unpacked copy is deleted afterwards. Exit code: 0 = restored and checked.
set -euo pipefail
umask 077

HOST=${1:?usage: restore-test.sh <ssh host> [age key file]}
KEY=${2:-$HOME/.config/tara-backup/age-key.txt}
HERE=$(cd "$(dirname "$0")" && pwd)
REMOTE_BIN=/usr/local/sbin/tara-backup

[[ -r $KEY ]] || { echo "No age key at $KEY" >&2; exit 2; }
work=$(mktemp -d "${TMPDIR:-/tmp}/tara-restore-test.XXXXXX")
trap 'rm -rf "$work"' EXIT

report() { # ok|failed key message
  ssh -o BatchMode=yes "$HOST" "sudo -n $REMOTE_BIN restore-result $1 $(printf %q "$2") $(printf %q "$3")" >/dev/null ||
    echo "warning: could not record the result on $HOST" >&2
}

info=$(ssh -o BatchMode=yes "$HOST" "sudo -n $REMOTE_BIN presign")
field() { node -e 'process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]]))' "$info" "$1"; }
key=$(field key)
echo "Restoring $key ($(($(field bytes) / 1000000)) MB, made $(field at))"

if ! curl -fsS --retry 3 -o "$work/archive.age" "$(field url)"; then
  report failed "$key" "download failed"; echo "Download failed" >&2; exit 1
fi
actual=$(shasum -a 256 "$work/archive.age" 2>/dev/null || sha256sum "$work/archive.age")
if [[ ${actual%% *} != "$(field sha256)" ]]; then
  report failed "$key" "sha256 of the download differs"; echo "sha256 differs" >&2; exit 1
fi
mkdir "$work/out"
if ! age -d -i "$KEY" "$work/archive.age" | tar -xzf - -C "$work/out"; then
  report failed "$key" "decrypt or unpack failed"; echo "Decrypt or unpack failed" >&2; exit 1
fi
rm -f "$work/archive.age"

if result=$(node --no-warnings "$HERE/tara-backup.mjs" verify "$work/out"); then
  summary=$(node -e 'const r=JSON.parse(process.argv[1]);const n=r.items.length;const rows=r.items.reduce((a,i)=>a+(i.rows||0),0);process.stdout.write(`${n} items restored and checked, ${rows} database rows`)' "$result")
  report ok "$key" "$summary"
  echo "OK: $summary"
else
  bad=$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(r.items.filter(i=>!i.ok).map(i=>`${i.name}: ${i.problems.join(", ")}`).join("; "))' "$result")
  report failed "$key" "$bad"
  echo "FAILED: $bad" >&2
  exit 1
fi
