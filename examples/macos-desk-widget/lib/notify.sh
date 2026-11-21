#!/bin/bash
# A macOS notification: notify.sh <title> <text> [url to open on click]
# terminal-notifier (brew install terminal-notifier) when present, so a click opens the page;
# otherwise osascript (a click then opens Script Editor). Text goes in as arguments, never as code.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
if command -v terminal-notifier >/dev/null 2>&1; then
  terminal-notifier -title "$1" -message "$2" ${3:+-open "$3"} -group tara-desk >/dev/null 2>&1
else
  osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' "$1" "$2" >/dev/null 2>&1
fi
exit 0
