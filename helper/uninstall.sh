#!/bin/bash
# Removes the 🫏 notes helper from this Mac.
LABEL="com.studynotes.helper"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/Library/Application Support/NotesHelper"
echo "The notes helper is removed."
