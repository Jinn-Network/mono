#!/usr/bin/env bash
# Post a planned X post + delayed self-reply, then monitor for replies and
# notify via ntfy with LLM-generated reply suggestions.
#
# Posts the +5 self-reply to fire the +75 author-reply mechanism (algorithm
# model §2; not an automatic feature of threads — see x-post-builder Stage 5a).
# Monitors the main post for replies during the cluster-peak first hour, asks
# claude to classify each reply and suggest a response in Oak's voice, sends
# both to ntfy. Does not auto-reply — Oak makes the call from the brief.
#
# Usage:
#   ./post-with-monitoring.sh <main.txt> <reply.txt> [options]
#
# Options:
#   --topic <ntfy-topic>     ntfy topic (default: $NTFY_TOPIC env or "oak-jinn-x-monitor")
#   --reply-delay <minutes>  Delay between main and self-reply (default: 5)
#   --monitor-window <min>   How long to monitor (default: 90)
#   --poll-interval <min>    Poll interval (default: 10)
#   --dry-run                Print actions only; do not post or notify
#
# Run in tmux/screen or with nohup; the script blocks for monitor-window minutes.
#
# Requirements: bird, jq, claude (optional — degrades gracefully), curl.

set -euo pipefail

# ----- args -----
MAIN_FILE="${1:-}"
REPLY_FILE="${2:-}"
[[ -n "$MAIN_FILE" ]] && shift
[[ -n "$REPLY_FILE" ]] && shift

TOPIC="${NTFY_TOPIC:-oak-jinn-x-monitor}"
REPLY_DELAY=5
MONITOR_WINDOW=90
POLL_INTERVAL=10
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --topic) TOPIC="$2"; shift 2 ;;
        --reply-delay) REPLY_DELAY="$2"; shift 2 ;;
        --monitor-window) MONITOR_WINDOW="$2"; shift 2 ;;
        --poll-interval) POLL_INTERVAL="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help) sed -n '2,/^$/p' "$0"; exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

if [[ -z "${MAIN_FILE:-}" || -z "${REPLY_FILE:-}" ]]; then
    echo "Usage: $0 <main.txt> <reply.txt> [options]" >&2
    exit 2
fi

[[ -f "$MAIN_FILE" ]]  || { echo "ERROR: $MAIN_FILE not found" >&2; exit 2; }
[[ -f "$REPLY_FILE" ]] || { echo "ERROR: $REPLY_FILE not found" >&2; exit 2; }

for cmd in bird jq curl; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not in PATH" >&2; exit 2; }
done

MAIN_TEXT=$(cat "$MAIN_FILE")
REPLY_TEXT=$(cat "$REPLY_FILE")
NTFY_URL="https://ntfy.sh/${TOPIC}"

ntfy() {
    local msg="$1"
    local title="${2:-Jinn X monitor}"
    if [[ "$DRY_RUN" == "true" ]]; then
        echo "[ntfy dry-run] [$title]"
        echo "$msg" | sed 's/^/  /'
        return
    fi
    curl -s -H "Title: $title" -d "$msg" "$NTFY_URL" >/dev/null \
        || echo "[ntfy] failed to send notification"
}

extract_url() {
    grep -oE 'https://(twitter|x)\.com/[^[:space:]]+/status/[0-9]+' | head -1
}

trap 'ntfy "Script interrupted at $(date -u +%H:%M:%S UTC). Manual cleanup may be needed." "Jinn X monitor (interrupted)"; exit 130' INT TERM

# ----- Stage 1: post main -----
echo "Main post (${#MAIN_TEXT} chars):"
printf -- '---\n%s\n---\n' "$MAIN_TEXT"

if [[ "$DRY_RUN" == "true" ]]; then
    MAIN_URL="https://x.com/tannedoaksprout/status/DRYRUN_MAIN"
    echo "[dry-run] would post main"
else
    MAIN_OUTPUT=$(bird tweet "$MAIN_TEXT" --plain 2>&1) || {
        echo "ERROR: bird tweet failed:" >&2
        echo "$MAIN_OUTPUT" >&2
        ntfy "Main post FAILED. Check terminal." "Jinn X monitor (FAILED)"
        exit 1
    }
    MAIN_URL=$(echo "$MAIN_OUTPUT" | extract_url)
    if [[ -z "$MAIN_URL" ]]; then
        echo "ERROR: could not extract main URL from bird output:" >&2
        echo "$MAIN_OUTPUT" >&2
        ntfy "Main post URL extraction FAILED. Check terminal." "Jinn X monitor (FAILED)"
        exit 1
    fi
fi

echo "Main posted: $MAIN_URL"
ntfy "Main posted: $MAIN_URL" "Jinn X monitor"

# ----- Stage 2: wait, post self-reply -----
DELAY_SECS=$((REPLY_DELAY * 60))
echo "Waiting ${REPLY_DELAY}min before self-reply..."
sleep "$DELAY_SECS"

echo "Reply (${#REPLY_TEXT} chars):"
printf -- '---\n%s\n---\n' "$REPLY_TEXT"

if [[ "$DRY_RUN" == "true" ]]; then
    REPLY_URL="https://x.com/tannedoaksprout/status/DRYRUN_REPLY"
    echo "[dry-run] would post self-reply"
else
    REPLY_OUTPUT=$(bird reply "$MAIN_URL" "$REPLY_TEXT" --plain 2>&1) || {
        echo "ERROR: bird reply failed:" >&2
        echo "$REPLY_OUTPUT" >&2
        ntfy "Self-reply FAILED. Main post is live; reply did not land." "Jinn X monitor (FAILED)"
        exit 1
    }
    REPLY_URL=$(echo "$REPLY_OUTPUT" | extract_url)
    if [[ -z "$REPLY_URL" ]]; then
        echo "ERROR: could not extract reply URL from bird output:" >&2
        echo "$REPLY_OUTPUT" >&2
        ntfy "Self-reply URL extraction FAILED. Check terminal." "Jinn X monitor (FAILED)"
        exit 1
    fi
fi

echo "Self-reply posted: $REPLY_URL"
ntfy "Self-reply posted: $REPLY_URL" "Jinn X monitor"

# ----- Stage 3: monitor replies -----
SEEN_FILE=$(mktemp -t bird-monitor.XXXXXX)
trap 'rm -f "$SEEN_FILE"' EXIT

NUM_POLLS=$((MONITOR_WINDOW / POLL_INTERVAL))
POLL_SECS=$((POLL_INTERVAL * 60))

echo "Monitoring ${MAIN_URL} for replies"
echo "  ${POLL_INTERVAL}min × ${NUM_POLLS} polls = ${MONITOR_WINDOW}min total"
ntfy "Monitoring started. ${NUM_POLLS} × ${POLL_INTERVAL}min polls." "Jinn X monitor"

interpret_reply() {
    local author="$1"
    local body="$2"
    local url="$3"

    if ! command -v claude >/dev/null 2>&1; then
        echo "(claude CLI not in PATH — no automated suggestion)"
        return
    fi

    local prompt_file
    prompt_file=$(mktemp -t bird-prompt.XXXXXX)
    {
        printf 'You are helping Oak (@tannedoaksprout) respond on X. The original post (Sprint #3 Teach #1, recruiting OSS coding agent contributors to Jinn Network):\n\n"""\n%s\n"""\n\n' "$MAIN_TEXT"
        printf 'A reply just landed from @%s: "%s"\n\n' "$author" "$body"
        printf 'URL: %s\n\n' "$url"
        cat <<'CTX'
Context:
- Jinn is a public-good network for agentic training data. The cluster-recognisable pitch instance is "collectively train a swe-rebench v2 harness".
- Bridge model: static benchmarks are last year's coding agents; live eval against rolling fresh GitHub issues is a coordination problem nobody owns.
- Voice: British English, blunt, no emoji, no marketing register, names mechanism over rhetoric, ZERO insider-shorthand (do not write "the cluster", "the loop", or any canonical word the reader has no antecedent for).
- No em-dashes (use parens or rewrite). No "Instead," at sentence start.
- The +75 author-reply mechanism fires when Oak replies back to substantive replies. Reply if the engagement is real; skip if it is pile-on, dismissal, or off-topic.

In under 200 words:
1. Classify (substantive pushback / agreement / question / dismissal / off-topic / shitpost).
2. Name the strongest pushback shape if any.
3. Suggest a 1-3 sentence reply in Oak's voice that fires the +75 mechanism, OR say "do not reply" with a one-line reason.

Be terse. No filler. No validation phrases like "great question".
CTX
    } > "$prompt_file"

    claude -p "$(cat "$prompt_file")" 2>/dev/null || echo "(claude call failed)"
    rm -f "$prompt_file"
}

for ((i=1; i<=NUM_POLLS; i++)); do
    sleep "$POLL_SECS"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "[dry-run] poll $i/$NUM_POLLS — would fetch replies"
        continue
    fi

    REPLIES_JSON=$(bird replies "$MAIN_URL" --json 2>/dev/null || echo '[]')

    NEW_COUNT=0
    while IFS= read -r reply; do
        [[ -z "$reply" ]] && continue
        REPLY_ID=$(echo "$reply" | jq -r '.id_str // .id // empty')
        REPLY_BODY=$(echo "$reply" | jq -r '.full_text // .text // empty')
        REPLY_AUTHOR=$(echo "$reply" | jq -r '.user.screen_name // .user.username // empty')
        REPLY_URL_INNER=$(echo "$reply" | jq -r '.url // ("https://x.com/" + (.user.screen_name // "_") + "/status/" + (.id_str // .id // ""))')

        [[ -z "$REPLY_ID" ]] && continue
        if grep -qFx "$REPLY_ID" "$SEEN_FILE" 2>/dev/null; then continue; fi
        echo "$REPLY_ID" >> "$SEEN_FILE"

        if [[ "$REPLY_AUTHOR" == "tannedoaksprout" ]]; then continue; fi

        echo ""
        echo "NEW REPLY @${REPLY_AUTHOR}:"
        echo "$REPLY_BODY"

        SUGGESTION=$(interpret_reply "$REPLY_AUTHOR" "$REPLY_BODY" "$REPLY_URL_INNER")

        ntfy "From @${REPLY_AUTHOR}:
${REPLY_BODY}

URL: ${REPLY_URL_INNER}

Suggestion:
${SUGGESTION}" "New reply (poll ${i}/${NUM_POLLS})"

        NEW_COUNT=$((NEW_COUNT + 1))
    done < <(echo "$REPLIES_JSON" | jq -c '.[]?' 2>/dev/null)

    echo "Poll ${i}/${NUM_POLLS}: ${NEW_COUNT} new"
done

ntfy "Monitoring window closed (${MONITOR_WINDOW}min). Manual review from here." "Jinn X monitor (done)"
echo "Done."
