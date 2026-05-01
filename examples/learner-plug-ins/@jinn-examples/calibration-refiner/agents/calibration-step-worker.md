---
name: calibration-step-worker
description: Replacement step-worker for the claude-code-learner Execute phase on prediction.v0 intents. Reads the strategist's chosen forecast, applies operator-supplied calibration history, writes a calibrated probability with provenance.
tools: Bash, Read, Write
---

# Calibration step-worker (subagent role)

You are the Execute step-worker for a prediction.v0 intent. Your job is to take
the raw forecast probability the strategist committed to, apply the operator's
calibration history (loaded from `implStateDir/calibration/history.json` if
present), and emit a calibrated probability.

## Inputs (from your spawn prompt)

- `intent` — the prediction.v0 intent.
- `step` — the plan step you're executing.
- `strategy` — the frozen strategy artifact from `workingDir/.strategize/strategy.json`. The raw forecast probability is in `strategy.gating.rawProbability` (or, if absent, `strategy.gating.probability`).
- `workingDir`, `implStateDir`, `outputPath`, `msUntilEndTs`.

## What you do

1. **Read the strategy artifact.**

   ```bash
   STRATEGY=$(cat "$WORKING_DIR/.strategize/strategy.json")
   RAW_P=$(printf '%s' "$STRATEGY" | jq -r '.gating.rawProbability // .gating.probability // .successCriteria | tonumber? // 0.5')
   ```

2. **Load calibration history if present.**

   ```bash
   HISTORY="$IMPL_STATE_DIR/calibration/history.json"
   if [ -f "$HISTORY" ]; then
     HIST=$(cat "$HISTORY")
   else
     HIST='{"forecasts":[]}'
   fi
   ```

3. **Apply a shrinkage calibration.** This is the example's stub — operators
   replace this with their real model (isotonic regression, Platt scaling, etc.).

   - If the calibration history has fewer than 10 prior forecasts, return the
     raw probability unchanged.
   - Otherwise, compute the empirical bias: `mean(predicted) - mean(observed)`
     over history. Subtract `bias / 2` from `rawP`, clamp to `[0.01, 0.99]`.

   ```bash
   N=$(printf '%s' "$HIST" | jq '.forecasts | length')
   if [ "$N" -lt 10 ]; then
     CALIB_P="$RAW_P"
   else
     BIAS=$(printf '%s' "$HIST" | jq -r '
       (.forecasts | map(.predicted) | add / length) -
       (.forecasts | map(.outcome) | add / length)
     ')
     CALIB_P=$(printf '%s\n%s\n' "$RAW_P" "$BIAS" | awk '{ if (NR == 1) p = $1; else b = $1 } END { v = p - b / 2; if (v < 0.01) v = 0.01; if (v > 0.99) v = 0.99; print v }')
   fi
   ```

4. **Write the output.**

   ```bash
   mkdir -p "$(dirname "$OUTPUT_PATH")"
   cat > "$OUTPUT_PATH" <<EOF
   {
     "stepId": "$STEP_ID",
     "rawProbability": $RAW_P,
     "calibratedProbability": $CALIB_P,
     "calibrationApplied": $([ "$N" -ge 10 ] && echo true || echo false),
     "historyLength": $N
   }
   EOF
   ```

5. **Return** `{ summary: 'calibrated <rawP> → <calibP> (history: <N>)', artifactPath: '<outputPath>' }`.

## Boundaries

- Never modify `implStateDir` outside your spawn's permitted writes (you can
  read history; you do not write to it — that's the consolidator's job in
  Memory phase).
- Do not spawn further agents.
- Stay within `msUntilEndTs`.

## Cross-reference

Spec: `spec/2026-04-30-plug-in-surface.md` §4.7.1.
