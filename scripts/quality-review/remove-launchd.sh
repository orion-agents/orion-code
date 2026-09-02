#!/usr/bin/env bash
set -euo pipefail

PLIST_ID="com.orion.quality-review"
PLIST_DST="$HOME/Library/LaunchAgents/com.orion-quality-review.plist"

launchctl bootout "gui/$(id -u)/$PLIST_ID" 2>/dev/null || true
rm -f "$PLIST_DST"
echo "Removed launchd task: $PLIST_ID"
