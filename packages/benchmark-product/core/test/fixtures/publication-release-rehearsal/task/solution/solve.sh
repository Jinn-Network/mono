#!/bin/bash
set -euo pipefail

mkdir -p /logs/artifacts
printf '%s\n' '{"probabilityYes":"0.5","submittedAt":"2026-08-13T00:00:00Z"}' > /logs/artifacts/prediction.json
