#!/bin/bash

# Script to restart all services cleanly

echo "🛑 Stopping all services..."

# Kill by port
lsof -ti:42070 | xargs kill -9 2>/dev/null || echo "  - Ponder (port 42070) not running"
lsof -ti:4001 | xargs kill -9 2>/dev/null || echo "  - Control API (port 4001) not running"

# Kill by process name
pkill -f "ponder" 2>/dev/null || echo "  - No ponder processes found"
pkill -f "control-api" 2>/dev/null || echo "  - No control-api processes found"
pkill -f "mech_worker" 2>/dev/null || echo "  - No mech_worker processes found"

echo "⏳ Waiting for ports to be released..."
sleep 3

echo "🚀 Starting services..."

cd /Users/gcd/Repositories/main/jinn-cli-agents

# Start Ponder
echo "  - Starting Ponder..."
yarn ponder > /tmp/ponder.log 2>&1 &
PONDER_PID=$!
echo "    PID: $PONDER_PID"

sleep 2

# Start Control API
echo "  - Starting Control API..."
yarn control-api > /tmp/control-api.log 2>&1 &
CONTROL_PID=$!
echo "    PID: $CONTROL_PID"

sleep 2

# Start Mech Worker
echo "  - Starting Mech Worker..."
yarn mech > /tmp/mech.log 2>&1 &
MECH_PID=$!
echo "    PID: $MECH_PID"

echo ""
echo "⏳ Waiting for services to initialize (10 seconds)..."
sleep 10

echo ""
echo "📊 Service Status:"
echo ""
echo "Ponder:"
tail -5 /tmp/ponder.log
echo ""
echo "Control API:"
tail -5 /tmp/control-api.log
echo ""
echo "Mech Worker:"
tail -5 /tmp/mech.log
echo ""
echo "✅ Services started!"
echo "   Logs: /tmp/ponder.log, /tmp/control-api.log, /tmp/mech.log"

