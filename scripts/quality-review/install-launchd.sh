#!/usr/bin/env bash
set -euo pipefail

PLIST_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/com.orion-quality-review.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.orion-quality-review.plist"
PLIST_ID="com.orion.quality-review"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DST"
launchctl bootout "gui/$(id -u)/$PLIST_ID" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "Installed: $PLIST_DST"
