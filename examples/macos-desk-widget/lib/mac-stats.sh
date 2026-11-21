#!/bin/bash
# Mac panel data as one JSON object, printed once. Run by mac.jsx every few seconds.
# Cheap on purpose: reads a cached macmon sample, one ps, two sysctls (~0.03 s CPU).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
VM_LABEL="VM"
[ -f "$DIR/config.local.sh" ] && . "$DIR/config.local.sh"

# macmon: the latest sample from the feeder (lib/macmon-feed.sh), started here when it is not
# running. Until it has a fresh sample (first run, or the feeder just restarted), take one directly.
CACHE="$HOME/Library/Caches/tara-desk-widget"
mkdir -p "$CACHE"
now="$(date +%s)"
echo "$now" > "$CACHE/wanted"
macmon_json="null"
if command -v macmon >/dev/null 2>&1; then
  if ! { [ -f "$CACHE/feed.pid" ] && kill -0 "$(cat "$CACHE/feed.pid")" 2>/dev/null; }; then
    nohup "$DIR/lib/macmon-feed.sh" "$CACHE" 5000 >/dev/null 2>&1 </dev/null &
  fi
  if [ -f "$CACHE/macmon.json" ] && [ $((now - $(stat -f %m "$CACHE/macmon.json"))) -le 15 ]; then
    out="$(cat "$CACHE/macmon.json")"
  else
    out="$(macmon pipe -s 1 -i 1000 2>/dev/null | head -n 1)"
  fi
  [ -n "$out" ] && macmon_json="$out"
fi

thermal="null"
helper="$CACHE/thermal"
[ -x "$helper" ] && thermal="$("$helper" 2>/dev/null || echo null)"

pressure="$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo null)"
ncpu="$(sysctl -n hw.ncpu)"
memsize="$(sysctl -n hw.memsize)"

# Processes grouped by app: a helper inside "Google Chrome.app" counts as Google Chrome,
# and every virtual machine process counts as the VM. Top 6 by CPU, plus the VM group.
groups="$(ps -Ao pcpu=,rss=,comm= | awk -v vm="$VM_LABEL" '
  {
    cpu = $1; rss = $2
    sub(/^[ \t]*[^ \t]+[ \t]+[^ \t]+[ \t]+/, "")
    path = $0
    if (path ~ /Virtualization\.VirtualMachine|qemu-system|\/UTM\.app\/|Parallels|VMware/) name = vm
    else if (match(path, /[^\/]*\.app\//)) name = substr(path, RSTART, RLENGTH - 5)
    else { n = split(path, parts, "/"); name = parts[n] }
    gsub(/[\\"]/, "", name)
    c[name] += cpu; r[name] += rss
  }
  END { for (k in c) printf "%.1f\t%d\t%s\n", c[k], r[k], k }' |
  sort -rn | awk -F'\t' -v vm="$VM_LABEL" '
    NR <= 6 || $3 == vm { printf "%s{\"name\":\"%s\",\"cpu\":%s,\"rssKb\":%s}", (n++ ? "," : ""), $3, $1, $2 }')"

printf '{"at":%s,"ncpu":%s,"memsize":%s,"pressure":%s,"thermal":%s,"vmLabel":"%s","groups":[%s],"macmon":%s}\n' \
  "$now" "$ncpu" "$memsize" "$pressure" "$thermal" "$VM_LABEL" "$groups" "$macmon_json"
