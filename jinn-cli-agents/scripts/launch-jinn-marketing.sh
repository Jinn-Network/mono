#!/bin/bash

##
# Launch Jinn Marketing Venture
#
# Wrapper script that launches the Jinn Marketing venture with pre-configured parameters.
#
# Usage:
#   ./scripts/launch-jinn-marketing.sh [repo_path] [--test]
#
# Arguments:
#   repo_path  Path to jinn-marketing repository (default: ~/jinn-repos/jinn-marketing)
#   --test     Use .env.test instead of .env
##

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

REPO_PATH="${1:-$HOME/jinn-repos/jinn-marketing}"
TEST_FLAG=""

if [[ "${2:-}" == "--test" ]]; then
  TEST_FLAG="--test"
fi

REPO_PATH="${REPO_PATH/#\~/$HOME}"

log_step "Launching Jinn Marketing Venture"
log_info "Repository: $REPO_PATH"
log_info "Mode: ${TEST_FLAG:-production}"

CEO_PROMPT_FILE="$SCRIPT_DIR/../docs/prompts/jinn-marketing-ceo-prompt.md"
if [[ ! -f "$CEO_PROMPT_FILE" ]]; then
  log_error "CEO prompt file not found: $CEO_PROMPT_FILE"
  exit 1
fi

export CONTEXT_FILE="$CEO_PROMPT_FILE"

"$SCRIPT_DIR/launch-venture.sh" \
  ${TEST_FLAG:+$TEST_FLAG} \
  --repo "$REPO_PATH" \
  --job-name "Jinn Marketing CEO" \
  --objective "Maximize awareness of Jinn across the internet by orchestrating a coordinated multi-agent marketing organization" \
  --acceptance-criteria "Success is measured by impressions. You will: 1. Set up core marketing infrastructure (blog, social media, analytics), 2. Create and distribute content showcasing Jinn's capabilities, 3. Engage with relevant communities (HN, Reddit, Twitter), 4. Experiment with narratives and channels to maximize reach, 5. Report weekly on impressions and optimize based on data, 6. Request human help clearly when blocked (credentials, approvals, paid services)" \
  --deliverables "Marketing infrastructure setup, initial content published, analytics tracking in place, weekly impression reports" \
  --constraints "Follow the venture spec strictly. Never publish without tracking. Always cite sources for technical claims. Prioritize free/OSS tools. Request paid services only with ROI justification."

log_success "🎉 Jinn Marketing venture launched!"
log_info "The worker will process the job and the CEO agent will begin orchestrating marketing operations."
