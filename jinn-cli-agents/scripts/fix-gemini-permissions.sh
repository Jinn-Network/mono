#!/bin/bash
# Fix macOS extended attributes causing EPERM errors in Gemini CLI
# Run this manually before starting the worker: sudo ./scripts/fix-gemini-permissions.sh

set -e

GEMINI_TMP="${HOME}/.gemini/tmp"

echo "🔧 Fixing Gemini CLI permission issues..."

# Remove com.apple.provenance extended attributes
if [ -d "$GEMINI_TMP" ]; then
    echo "   Removing extended attributes from $GEMINI_TMP..."
    xattr -r -d com.apple.provenance "$GEMINI_TMP" 2>/dev/null || true
    
    echo "   Clearing cached project directories..."
    rm -rf "${GEMINI_TMP}"/* 2>/dev/null || true
    
    echo "✅ Cleanup complete"
else
    echo "⚠️  Directory $GEMINI_TMP does not exist yet"
fi

echo ""
echo "You can now run the worker:"
echo "  yarn mech --single"





