#!/bin/bash
exec yarn exec tsx "$(dirname "$0")/mock-agent.ts" "$@"
