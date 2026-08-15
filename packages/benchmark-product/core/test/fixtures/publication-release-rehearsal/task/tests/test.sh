#!/bin/bash
set -euo pipefail

expected='{"probabilityYes":"0.5","submittedAt":"2026-08-13T00:00:00Z"}'
actual="$(tr -d '\n' < /logs/artifacts/prediction.json)"
mkdir -p /logs/verifier
if [[ "$actual" == "$expected" ]]; then
  printf '1\n' > /logs/verifier/reward.txt
  exit 0
fi

printf '0\n' > /logs/verifier/reward.txt
exit 1
