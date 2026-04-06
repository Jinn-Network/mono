#!/bin/bash
# Check if port 42070 is in use and exit with error if so
if lsof -Pi :42070 -sTCP:LISTEN -t >/dev/null ; then
    echo "ERROR: Port 42070 is already in use!"
    echo "Process using port 42070:"
    lsof -i :42070
    exit 1
fi
echo "✓ Port 42070 is available"

