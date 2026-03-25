#!/bin/bash
exec npx tsx "$(dirname "$0")/mock-agent.ts" "$@"
