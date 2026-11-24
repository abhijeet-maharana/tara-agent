#!/bin/bash
# Reports this Mac's figures to tara-agent (POST /vmhost/metrics), for a Mac that runs tara-agent's VM.
# Run every 5 minutes by the LaunchAgent that `install.sh --metrics` sets up; safe to run by hand.
# Also the "agent is off" alert: when tara-agent doesn't answer twice in a row (10 minutes), a macOS
# notification says so (and whether the VM process is running at all), and another when it is back.
# NOTIFY="0" in config.local.sh turns the notifications off.
# Reuses the Mac panel's numbers (mac-stats.sh) and reshapes them with JavaScript for Automation,
# which every Mac has, so nothing needs installing.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
TARA_URL="http://localhost:4000"
TARA_KEYCHAIN_SERVICE=""
HOST_NAME="Mac"
AGENT_NAME="tara-agent"
NOTIFY="1"
[ -f "$DIR/config.local.sh" ] && . "$DIR/config.local.sh"
TARA_URL="${TARA_URL%/}"

stats="$("$DIR/lib/mac-stats.sh")" || exit 1
# Seconds since the keyboard or mouse was last used (HIDIdleTime is in nanoseconds).
idle="$(ioreg -c IOHIDSystem | awk '/HIDIdleTime/ { print int($NF / 1000000000); exit }')"
payload="$(osascript -l JavaScript - "$stats" "$HOST_NAME" "$idle" <<'JXA'
function run(argv) {
  const d = JSON.parse(argv[0]);
  const m = d.macmon || {};
  const mem = m.memory || {};
  const vm = (d.groups || []).find((g) => g.name === d.vmLabel);
  const out = {
    name: argv[1],
    cpuTemp: m.temp ? m.temp.cpu_temp_avg : undefined,
    thermal: ['nominal', 'fair', 'serious', 'critical'][d.thermal],
    cpu: m.cpu_usage_pct,
    memUsed: mem.ram_total ? mem.ram_usage / mem.ram_total : undefined,
    swapBytes: mem.swap_usage,
    pressure: { 1: 'normal', 2: 'warn', 4: 'critical' }[d.pressure],
    vmCpu: vm ? Math.min(1, vm.cpu / 100 / d.ncpu) : undefined,
    vmMemBytes: vm ? vm.rssKb * 1024 : undefined,
    powerW: m.sys_power || m.all_power,
    idleSec: argv[2] === '' ? undefined : Number(argv[2]),
  };
  return JSON.stringify(out);
}
JXA
)" || exit 1

auth=()
if [ -n "$TARA_KEYCHAIN_SERVICE" ]; then
  token="$(security find-generic-password -s "$TARA_KEYCHAIN_SERVICE" -w 2>/dev/null)"
  [ -n "$token" ] && auth=(-H "Authorization: Bearer $token")
fi
STATE="${TARA_DESK_STATE:-$HOME/Library/Caches/tara-desk}"
mkdir -p "$STATE"
fails_file="$STATE/agent-not-answering"
alert() { [ "$NOTIFY" = "1" ] && "$DIR/lib/notify.sh" "$1" "$2" "$TARA_URL"; }

if curl -sS -f -m 10 "${auth[@]}" -H 'content-type: application/json' --data "$payload" "$TARA_URL/vmhost/metrics" >/dev/null; then
  n=$(cat "$fails_file" 2>/dev/null || echo 0)
  [ "$n" -ge 2 ] && alert "$AGENT_NAME is back" "Answering again at $TARA_URL"
  rm -f "$fails_file"
else
  n=$(( $(cat "$fails_file" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$fails_file"
  if [ "$n" -eq 2 ]; then
    # A Mac running the VM: is the VM process there at all?
    if pgrep -f 'com.apple.Virtualization.VirtualMachine' >/dev/null 2>&1; then
      vm="The VM is running, so tara-agent or the network inside it is stuck"
    else
      vm="No VM is running on this Mac: start it"
    fi
    alert "$AGENT_NAME is not answering" "No answer from $TARA_URL for 10 minutes. $vm."
  fi
  exit 1
fi
