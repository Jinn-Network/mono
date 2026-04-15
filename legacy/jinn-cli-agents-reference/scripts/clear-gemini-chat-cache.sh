#!/bin/bash
# Clear protected Gemini CLI chat files to fix EPERM errors

echo "Clearing Gemini CLI chat cache..."
rm -rf ~/.gemini/tmp/*/chats/* 2>/dev/null
echo "✓ Cache cleared"
echo ""
echo "This fixes the EPERM error by removing protected chat history files."
echo "Gemini CLI will create fresh files that are not protected."

