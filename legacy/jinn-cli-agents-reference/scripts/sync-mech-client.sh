#!/bin/bash
set -e

PACKAGE_DIR="packages/mech-client-ts"
STANDALONE_DIR="../mech-client-ts"

echo "🔄 Syncing mech-client-ts to standalone repo..."

# Check if standalone repo exists
if [ ! -d "$STANDALONE_DIR" ]; then
  echo "❌ Error: Standalone repo not found at $STANDALONE_DIR"
  exit 1
fi

# Copy files (exclude dev artifacts)
rsync -av --delete \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.yarn' \
  --exclude 'yarn.lock' \
  --exclude '*.tgz' \
  --exclude '.DS_Store' \
  --exclude '.git' \
  "$PACKAGE_DIR/" "$STANDALONE_DIR/"

echo "✅ Files synced successfully!"
echo ""
echo "📝 Next steps:"
echo "  1. cd $STANDALONE_DIR"
echo "  2. Review changes: git status"
echo "  3. Commit: git add . && git commit -m 'sync: update from jinn-gemini'"
echo "  4. Update version in package.json if needed (bump from current version)"
echo "  5. Build and test: yarn build && npm pack --dry-run"
echo "  6. Push: git push"
echo "  7. Create GitHub release to trigger automated npm publish"
echo ""
echo "💡 Or for immediate npm publish (manual):"
echo "  1. Make sure you're logged in with Jinn Network npm account: npm whoami"
echo "  2. npm publish --access public"
