#!/bin/bash
# The agent panel's data as one JSON line, run by agent.jsx every 30 s:
#   {"name", "url", "notify", "state": GET /glance, "attention": GET /attention | null, "extra": EXTRA_TILES_URL | null}
# or {"name", "url", "error"} when /glance can't be read. Never fails, so the panel can say "offline".
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
TARA_URL="http://localhost:4000"
TARA_KEYCHAIN_SERVICE=""
AGENT_NAME="tara"
EXTRA_TILES_URL=""
NOTIFY="1"
[ -f "$DIR/config.local.sh" ] && . "$DIR/config.local.sh"
TARA_URL="${TARA_URL%/}"

# Only when the host sets TARA_HTTP_TOKEN: the token is read from the login Keychain, never a file.
auth=()
if [ -n "$TARA_KEYCHAIN_SERVICE" ]; then
  token="$(security find-generic-password -s "$TARA_KEYCHAIN_SERVICE" -w 2>/dev/null)"
  [ -n "$token" ] && auth=(-H "Authorization: Bearer $token")
fi

# A JSON object from a URL, or "null" (optional parts must never break the panel).
object() {
  local out
  out="$(curl -s -f -m 5 "$@" 2>/dev/null)"
  if [ $? -eq 0 ] && [ "${out:0:1}" = "{" ]; then printf '%s' "$out"; else printf 'null'; fi
}

body="$(curl -sS -f -m 5 "${auth[@]}" "$TARA_URL/glance" 2>&1)"
if [ $? -eq 0 ] && [ "${body:0:1}" = "{" ]; then
  attention="$(object "${auth[@]}" "$TARA_URL/attention")"
  extra="null"
  [ -n "$EXTRA_TILES_URL" ] && extra="$(object "$EXTRA_TILES_URL")"
  notify=false; [ "$NOTIFY" = "1" ] && notify=true
  printf '{"name":"%s","url":"%s","notify":%s,"state":%s,"attention":%s,"extra":%s}\n' \
    "$AGENT_NAME" "$TARA_URL" "$notify" "$body" "$attention" "$extra"
else
  err="$(printf '%s' "$body" | head -n 1 | tr -d '"\\' | cut -c1-120)"
  printf '{"name":"%s","url":"%s","error":"%s"}\n' "$AGENT_NAME" "$TARA_URL" "${err:-no answer}"
fi
