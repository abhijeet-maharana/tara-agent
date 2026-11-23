#!/bin/bash
# Reports this Mac's figures to tara-agent (POST /vmhost/metrics), for a Mac that runs tara-agent's VM.
# Run every 5 minutes by the LaunchAgent that `install.sh --metrics` sets up; safe to run by hand.
# Reuses the Mac panel's numbers (mac-stats.sh) and reshapes them with JavaScript for Automation,
# which every Mac has, so nothing needs installing.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
TARA_URL="http://localhost:4000"
TARA_KEYCHAIN_SERVICE=""
HOST_NAME="Mac"
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
curl -sS -f -m 10 "${auth[@]}" -H 'content-type: application/json' --data "$payload" "$TARA_URL/vmhost/metrics" >/dev/null
