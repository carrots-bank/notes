#!/bin/bash
# Installs the 🫏 notes helper on this Mac: it starts at login and lets the notes website ask questions through
# the Claude (or ChatGPT/Codex) account on this computer. Run:  curl -fsSL <site>/helper/install.sh | bash
set -euo pipefail
SITE="${NOTES_SITE:-https://carrots-bank.github.io/notes}"
DIR="$HOME/Library/Application Support/NotesHelper"
PLIST="$HOME/Library/LaunchAgents/com.studynotes.helper.plist"
LABEL="com.studynotes.helper"

echo "Installing the notes helper…"
if ! /usr/bin/python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
  echo "macOS needs its developer tools for Python. A window will open: click Install, then run this command again."
  xcode-select --install 2>/dev/null || true
  exit 1
fi
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
if [ -n "${NOTES_HELPER_SRC:-}" ]; then cp "$NOTES_HELPER_SRC" "$DIR/notes-helper.py"
else curl -fsSL "$SITE/helper/notes-helper.py" -o "$DIR/notes-helper.py"; fi
ORIGIN="$(printf '%s' "$SITE" | sed -E 's#^(https?://[^/]+).*#\1#')"
# The relay service this site uses (from its public site.json): the helper will only ever connect to that one.
WORKER="${NOTES_HELPER_WORKERS:-$(curl -fsSL "$SITE/site.json" 2>/dev/null | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("annotations",""))' 2>/dev/null || true)}"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>$DIR/notes-helper.py</string></array>
  <key>EnvironmentVariables</key><dict><key>NOTES_HELPER_ORIGINS</key><string>$ORIGIN</string>
    <key>NOTES_HELPER_WORKERS</key><string>$WORKER</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$DIR/helper.err</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

for i in 1 2 3 4 5 6 7 8 9 10; do
  if STATUS="$(curl -fsS -H "Origin: $ORIGIN" http://127.0.0.1:47321/status 2>/dev/null)"; then break; fi; sleep 0.5
done
echo "Helper running: ${STATUS:-not responding yet}"
if ! printf '%s' "${STATUS:-}" | grep -q '"claude"\|"codex"'; then
  echo
  echo "No AI tool found yet. Install one, sign in once, and the helper will find it:"
  echo "  Claude (Pro or Max plan):  curl -fsSL https://claude.ai/install.sh | bash   then run:  claude"
  echo "  ChatGPT (Plus or Pro):     brew install --cask codex   (Homebrew from brew.sh)   then run:  codex login"
fi
echo "Done. Open the notes website and press 🫏."
