#!/usr/bin/env bash
#
# M-Code (corrugated barcode/QR QC demo) — one-shot Mac mini setup.
#
# Replaces the old Windows logon-script + Docker connector, which dropped
# offline whenever the laptop slept or the hotspot disconnected. On the Mac mini
# both pieces run as boot-time launchd services that auto-restart:
#
#   1. static web server -> launchd daemon  com.ericchh.mcode-web  (port 8765)
#      serves this repo dir so https://m-code.ericchh.work/demo/index.html works
#   2. cloudflared tunnel -> launchd daemon (optional, pass the token)
#
# The demo HTML imports the built ../dist/index.js, so this script runs the
# TypeScript build first (npm + tsc).
#
# Usage:
#   ./deploy/setup-macmini.sh                 # build + web service only
#   ./deploy/setup-macmini.sh <TUNNEL_TOKEN>  # build + web + cloudflared tunnel
#
# The tunnel token is the long string from the old Windows startup VBS
# (the m-code tunnel line, tunnel ID 2cad6e8b-...), or copy a fresh
# "service install" command from:
#   Cloudflare Zero Trust > Networks > Tunnels > m-code > Configure.
# It is a secret — it is NOT stored in this repo; pass it on the command line.
#
set -euo pipefail

TUNNEL_TOKEN="${1:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_USER="$(id -un)"
LOG_DIR="$HOME/Library/Logs/m-code"
PYTHON3="$(command -v python3 || true)"
PLIST_LABEL="com.ericchh.mcode-web"
PLIST_SRC="$SCRIPT_DIR/${PLIST_LABEL}.plist"
PLIST_DST="/Library/LaunchDaemons/${PLIST_LABEL}.plist"

echo "==> Repo:   $REPO_DIR"
echo "==> User:   $RUN_USER"
echo "==> Logs:   $LOG_DIR"

[[ -n "$PYTHON3" ]] || { echo "!! python3 not found. Install it (brew install python) and re-run." >&2; exit 1; }

# 1. Build the demo (TypeScript -> dist/) -------------------------------------
if ! command -v npm >/dev/null 2>&1; then
    echo "!! npm/node not found. Install Node (brew install node) and re-run." >&2
    exit 1
fi
echo "==> Installing dev deps and building dist/ ..."
( cd "$REPO_DIR" && npm ci && npm run build )
[[ -f "$REPO_DIR/dist/index.js" ]] || { echo "!! build did not emit dist/index.js" >&2; exit 1; }

mkdir -p "$LOG_DIR"

# 2. Install + (re)load the static web LaunchDaemon ---------------------------
echo "==> Installing web LaunchDaemon (needs sudo)..."
TMP_PLIST="$(mktemp)"
sed -e "s#@PYTHON3@#${PYTHON3}#g" \
    -e "s#@REPO_DIR@#${REPO_DIR}#g" \
    -e "s#@RUN_USER@#${RUN_USER}#g" \
    -e "s#@LOG_DIR@#${LOG_DIR}#g" \
    "$PLIST_SRC" > "$TMP_PLIST"

sudo cp "$TMP_PLIST" "$PLIST_DST"
sudo chown root:wheel "$PLIST_DST"
sudo chmod 644 "$PLIST_DST"
rm -f "$TMP_PLIST"

# bootout is harmless if it was never loaded; bootstrap (re)loads it.
sudo launchctl bootout system "$PLIST_DST" 2>/dev/null || true
sudo launchctl bootstrap system "$PLIST_DST"

echo "==> Waiting for the web server to come up..."
sleep 2
if curl -fsS "http://localhost:8765/demo/index.html" -o /dev/null; then
    echo "==> Web server is up:  http://localhost:8765/demo/index.html"
else
    echo "!! Web server did not answer yet. Check logs:"
    echo "     tail -f $LOG_DIR/mcode-web.err.log"
fi

# 3. Optional: cloudflared tunnel as a system service -------------------------
if [[ -n "$TUNNEL_TOKEN" ]]; then
    if ! command -v cloudflared >/dev/null 2>&1; then
        if command -v brew >/dev/null 2>&1; then
            echo "==> Installing cloudflared via Homebrew..."
            brew install cloudflared
        else
            echo "!! cloudflared not found and Homebrew is missing." >&2
            echo "   Install Homebrew (https://brew.sh) or cloudflared, then re-run with the token." >&2
            exit 1
        fi
    fi
    echo "==> Installing cloudflared tunnel as a system service..."
    sudo cloudflared service install "$TUNNEL_TOKEN"
    echo "==> Waiting for the tunnel to register..."
    sleep 5
    if curl -fsS "https://m-code.ericchh.work/demo/index.html" -o /dev/null; then
        echo "==> Public demo is live: https://m-code.ericchh.work/demo/index.html"
    else
        echo "!! Public endpoint not answering yet — give it a few seconds and retry:"
        echo "     curl -i https://m-code.ericchh.work/demo/index.html"
    fi
else
    cat <<'EOF'

==> Skipped cloudflared (no token argument).
    To finish the public tunnel, run once:

      brew install cloudflared
      sudo cloudflared service install <YOUR_M_CODE_TUNNEL_TOKEN>

    Cloudflare's ingress already maps m-code.ericchh.work -> localhost:8765,
    so there is nothing else to configure.
EOF
fi

cat <<'EOF'

----------------------------------------------------------------------
Done. Final step: retire the old Windows machine so only ONE host
serves this tunnel — delete / disable its m-code connector
(the Startup VBS / Docker `cloudflared-mcode` container).

Service management on the Mac mini:
  sudo launchctl bootout  system /Library/LaunchDaemons/com.ericchh.mcode-web.plist   # stop
  sudo launchctl bootstrap system /Library/LaunchDaemons/com.ericchh.mcode-web.plist  # start
  tail -f ~/Library/Logs/m-code/mcode-web.err.log                                     # logs

After editing code: `git pull && npm run build` then restart the web service.
----------------------------------------------------------------------
EOF
