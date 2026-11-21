#!/bin/bash
# Sets up the desk widget on this Mac. Safe to run again.
#   1. compiles the thermal-state helper into ~/Library/Caches/tara-desk-widget/
#   2. links this folder into Übersicht's widgets folder as "tara-desk-widget"
#   3. creates config.local.sh from config.example.sh if it is missing
#   4. adds Übersicht to the login items
# With --metrics, also a LaunchAgent that reports the Mac's figures to tara-agent every 5 minutes
# (lib/post-metrics.sh → POST /vmhost/metrics), for a Mac that runs tara-agent's VM.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
WIDGETS="$HOME/Library/Application Support/Übersicht/widgets"
CACHE="$HOME/Library/Caches/tara-desk-widget"

command -v macmon >/dev/null || echo "⚠️  macmon not found: brew install macmon (temperature and power show —)"
[ -d "/Applications/Übersicht.app" ] || { echo "❌ Übersicht missing: brew install --cask ubersicht"; exit 1; }

mkdir -p "$CACHE"
swiftc -O "$HERE/lib/thermal.swift" -o "$CACHE/thermal"
echo "✅ thermal helper: $CACHE/thermal ($("$CACHE/thermal"))"

mkdir -p "$WIDGETS"
ln -sfn "$HERE" "$WIDGETS/tara-desk-widget"
echo "✅ linked: $WIDGETS/tara-desk-widget → $HERE"

[ -f "$HERE/config.local.sh" ] || { cp "$HERE/config.example.sh" "$HERE/config.local.sh"; echo "✅ created config.local.sh: set TARA_URL"; }

osascript >/dev/null <<'OSA'
tell application "System Events"
  if not (exists login item "Übersicht") then make login item at end with properties {path:"/Applications/Übersicht.app", hidden:true}
end tell
OSA
echo "✅ Übersicht starts at login"
open -a "Übersicht"

if [ "${1:-}" = "--metrics" ]; then
  LABEL="com.github.tara-agent.vmhost-metrics"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HERE/lib/post-metrics.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/tara-desk-widget.log</string>
</dict>
</plist>
PL
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "✅ reports the Mac's figures to tara-agent every 5 min ($PLIST; errors in ~/Library/Logs/tara-desk-widget.log)"
fi
