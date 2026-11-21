# Copy to config.local.sh (git-ignored) and edit. Both panels read it on every refresh.

# Where tara-agent's dashboard listens, as seen from this Mac (e.g. its tailnet name).
TARA_URL="http://localhost:4000"

# Only if the host sets TARA_HTTP_TOKEN: the Keychain item that holds it, added once with
#   security add-generic-password -s tara-agent -a "$USER" -w
TARA_KEYCHAIN_SERVICE=""

# What to call the virtual machine on the Mac panel, if tara-agent runs in one on this Mac.
VM_LABEL="VM"

# How this Mac names itself in tara-agent (Health page, desk phone) when it reports with --metrics.
HOST_NAME="Mac"

# Panel title for the agent.
AGENT_NAME="tara"

# Optional: a URL returning extra tiles for the agent panel, e.g. your own service's status:
#   {"tiles": [{"label": "Queue", "href": "http://…", "items": [{"text": "3 stuck", "level": "bad", "title": "hover text"}]}]}
# level: ok | warn | bad | info. Left empty, no extra tiles.
EXTRA_TILES_URL=""

# Desktop notifications for new urgent alerts from tara-agent (never for alerts it holds in quiet hours).
NOTIFY="1"
