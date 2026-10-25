#!/usr/bin/env bash
# Moves a dedicated-user install (tara-agent and Claude both running as RUN_USER) to split users:
# tara-agent runs as AGENT_USER with its database, config and keys out of RUN_USER's reach, and
# starts Claude and pre-run scripts as RUN_USER through sudo. Run as root. Safe to run again.
#   sudo deploy/split-users.sh            set up (stops and restarts tara-agent)
#   sudo deploy/split-users.sh --rollback back to the single-user unit (the old state is kept)
set -euo pipefail

AGENT_USER=${AGENT_USER:-tara-agent}
RUN_USER=${RUN_USER:-tara}
CHECKOUT=${CHECKOUT:-$(cd "$(dirname "$0")/.." && pwd)}
RUN_HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)
OLD_STATE=${OLD_STATE:-$RUN_HOME/.local/state/tara-agent}
OLD_CONFIG=${OLD_CONFIG:-$RUN_HOME/.config/tara-agent/config.yaml}
STATE=/var/lib/tara-agent/state
CONFIG=/etc/tara-agent/config.yaml
ENV_FILE=/etc/tara-agent.env
UNIT=/etc/systemd/system/tara-agent.service

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

if [[ ${1:-} == --rollback ]]; then
  systemctl stop tara-agent
  cp "$CHECKOUT/deploy/systemd/tara-agent-dedicated-user.service" "$UNIT"
  systemctl daemon-reload && systemctl start tara-agent
  echo "Back on the single-user unit (state in $OLD_STATE; anything recorded since the split stays in $STATE)."
  exit 0
fi

# 1. The agent user: no login, member of the run user's group (repos, transcripts, scratch).
id "$AGENT_USER" &>/dev/null || useradd --system --home /var/lib/tara-agent --create-home --shell /usr/sbin/nologin "$AGENT_USER"
usermod -aG "$RUN_USER" "$AGENT_USER"
install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 700 /var/lib/tara-agent "$STATE"

# 2. sudo to the run user only, without a pty so stopping a run's process group stops Claude too.
cat >/etc/sudoers.d/tara-agent <<EOF
Defaults:$AGENT_USER !use_pty
$AGENT_USER ALL=($RUN_USER) NOPASSWD: ALL
EOF
chmod 440 /etc/sudoers.d/tara-agent
visudo -cf /etc/sudoers.d/tara-agent

# 3. The agent must reach its checkout (repos are shared with the run user's group, which it joins).
d=$CHECKOUT
while [[ $d != / ]]; do
  sudo -u "$AGENT_USER" test -x "$d" 2>/dev/null || setfacl -m "u:$AGENT_USER:x" "$d"
  d=$(dirname "$d")
done
# The run user's transcripts stay readable for the dashboard; its login (.credentials.json) does not.
setfacl -m "u:$AGENT_USER:x" "$RUN_HOME" "$RUN_HOME/.claude"
setfacl -R -m "u:$AGENT_USER:rX" "$RUN_HOME/.claude/projects"
setfacl -R -d -m "u:$AGENT_USER:rX" "$RUN_HOME/.claude/projects"

# 4. Config and keys.
install -d -o root -g "$AGENT_USER" -m 750 /etc/tara-agent
if [[ ! -f $CONFIG ]]; then
  cp "$OLD_CONFIG" "$CONFIG"
  grep -q '^stateDir:' "$CONFIG" || printf '\nstateDir: %s\n' "$STATE" >>"$CONFIG"
  if ! grep -q 'runAs:' "$CONFIG"; then
    # Under the existing `claude:` block.
    sed -i "s/^claude:\s*$/claude:\n  runAs: $RUN_USER/" "$CONFIG"
  fi
fi
chown root:"$AGENT_USER" "$CONFIG" && chmod 640 "$CONFIG"
for key in TARA_ADMIN_TOKEN APPROVAL_SEAL_KEY; do
  grep -q "^$key=" "$ENV_FILE" || echo "$key=$(openssl rand -hex 24)" >>"$ENV_FILE"
done
chmod 600 "$ENV_FILE"

# 5. Move the database (stopped, so nothing writes it meanwhile) and switch the unit.
systemctl stop tara-agent
if [[ ! -f $STATE/tara.db && -f $OLD_STATE/tara.db ]]; then
  cp -a "$OLD_STATE/." "$STATE/"
  chown -R "$AGENT_USER:$AGENT_USER" "$STATE"
fi
cp "$CHECKOUT/deploy/systemd/tara-agent-split-users.service" "$UNIT"
systemctl daemon-reload && systemctl start tara-agent
for _ in $(seq 20); do systemctl is-active --quiet tara-agent && break; sleep 1; done
systemctl is-active tara-agent || { journalctl -u tara-agent -n 20 --no-pager; echo "not running: see above, or --rollback" >&2; }

# 6. The checks that matter: the run user can't read the agent's state, config or env.
for f in "$STATE/tara.db" "$CONFIG" "$ENV_FILE"; do
  if sudo -u "$RUN_USER" test -r "$f"; then echo "WARNING: $RUN_USER can read $f" >&2; else echo "ok: $RUN_USER can't read $f"; fi
done
echo "TARA_ADMIN_TOKEN (unlock key for the Approvals page) is in $ENV_FILE"
