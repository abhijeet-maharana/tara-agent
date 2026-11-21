#!/bin/bash
# Keeps one macmon running and the latest sample in $CACHE/macmon.json.
# A long-running macmon costs ~0.01 s CPU per sample; starting one per sample costs ~0.09 s.
# Started by mac-stats.sh; stops itself once mac-stats.sh has not asked for a minute
# (it writes the time into $CACHE/wanted on every run), and macmon then exits on SIGPIPE.
CACHE="$1"
INTERVAL_MS="${2:-5000}"
echo $$ > "$CACHE/feed.pid"
last=""
same=0
macmon pipe -i "$INTERVAL_MS" 2>/dev/null | while IFS= read -r line; do
  printf '%s\n' "$line" > "$CACHE/macmon.tmp" && mv -f "$CACHE/macmon.tmp" "$CACHE/macmon.json"
  read -r wanted < "$CACHE/wanted" 2>/dev/null
  if [ "$wanted" = "$last" ]; then same=$((same + 1)); else same=0; last="$wanted"; fi
  [ "$same" -ge $((60000 / INTERVAL_MS)) ] && break
done
rm -f "$CACHE/feed.pid"
