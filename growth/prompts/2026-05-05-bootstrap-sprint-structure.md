# Bootstrap sprint structure into local growth files

**Run this once in a local Claude Code session on the machine that holds the canonical `growth/.local/` files (Oak's main).** It is a one-time migration — once §6/§7 exist in the growth-log and the CSV header has the four ladder columns, the daily `growth-day` skill takes over.

## Context

The `growth-day` skill in `.claude/skills/growth-day/SKILL.md` (recently updated) now refuses to produce a daily top-3 unless an active sprint is declared in `growth/.local/growth-log.md` §6. It also expects four ladder columns on `growth/.local/jinn-warm-contacts.csv` — `rung`, `last_touch_date`, `next_move`, `next_move_due`. This prompt brings the local files in line with that schema and declares Sprint #1.

Read `.claude/skills/growth-day/SKILL.md` first if you want the full rationale (sprint precondition, rung ladder, brief format, failure modes).

## Files you will edit

1. `growth/.local/growth-log.md` — add §6 (Active sprint) and §7 (Postmortem archive). Do **not** touch §1–§5; preserve them byte-for-byte.
2. `growth/.local/jinn-warm-contacts.csv` — append four columns to the header (`rung`, `last_touch_date`, `next_move`, `next_move_due`). Append four empty fields to every existing data row so column counts stay aligned.

Both files are gitignored. No commit is needed.

## Procedure

### Step 1 — Inspect

Read both files first. Then check:

- Does `growth-log.md` already contain a `## §6` heading? If yes, stop and surface to Oak — do not overwrite an active sprint.
- Does the CSV header already include any of `rung`, `last_touch_date`, `next_move`, `next_move_due`? If yes, stop and surface.
- Does `growth-log.md` use a different section-numbering convention (e.g. `## 1. …` instead of `## §1`)? If yes, match its existing style when adding the new sections — keep it consistent rather than forcing the §-prefix.

### Step 2 — Append §6 + §7 to `growth-log.md`

Append the block below to the end of `growth-log.md`. If the file already ends with `---` and trailing whitespace, place the new content after the last meaningful section without doubling separators.

The cluster definition in §6 is **verbatim from Oak (2026-05-05)** — preserve every word, including the lowercased "people", the asterisks around *builders*, the apostrophe in 'agents', and both bullet items. Do not paraphrase.

```markdown
---

## §6 Active sprint

One sprint at a time. While a sprint is active, `growth-day` appends daily progress under the `Daily progress` sub-section. At sprint end, write the postmortem to §7 *before* declaring the next sprint.

### Sprint #1 — jinn-adjacent

- **Window:** 2026-05-05 → 2026-05-19 (14 days)
- **Cluster definition (verbatim from Oak, 2026-05-05):**
  > * people who are serious operators on existing Jinn-adjacent projects. Specific Bittensor subnets for example. Olas, Allora, anything else that seems relevant. Though I have a lot of Olas followers already, so I think we get them for free.
  > * People who are serious *builders* on existing Jinn-adjacent projects. That could be people submitting signals for Numerai, or people who are developing 'agents' on Bittensor subnets.
- **Rationale for this cluster (Oak, 2026-05-05):** the agent-eval cluster (e.g. @askdrvoyage tier) is a bridge too far without crypto subtext; jinn-adjacent operators/builders already share the decentralisation prior, so the subtext lands without translation. OLAS followers come for free; Bittensor subnet operators, Numerai signal submitters, and Allora builders are the active recruitment surface.
- **Inputs target (2-week window):**
  - 6 teach posts in jinn-adjacent vocabulary (3/week)
  - Reply cascade after each teach post (≥3 in-cluster replies within 2 hours of posting)
  - 1 bridge post (target cluster: TBD — set on first growth-day after sprint start; default candidates: AI/agent-builder cluster, or AI×crypto cross-section)
- **Thresholds (decision-gating, evaluated 2026-05-19):**
  - 2 Tier-A contacts at WARM rung (multi-turn over the sprint window)
  - 1 inbound mention or quote-tweet from a Tier-A account
  - *Bonus, not gating:* 1 contact reaches HOT rung
- **Decision rule on 2026-05-19:**
  - Hit ≥1 threshold (+ bonus is gravy): double down on jinn-adjacent for sprint #2; consider adding cluster #2 in parallel.
  - Hit 0 thresholds: postmortem the gap (post quality? wrong sub-segment within the cluster? wrong people targeted?), pivot to a different cluster.
  - **Either way:** write the postmortem to §7. The postmortem is the forcing function — sprint #1 is mostly calibration regardless of pass/fail.

#### Daily progress

*Appended by `growth-day` each weekday morning. Format: `- YYYY-MM-DD — Inputs: …, Rungs advanced: …, Inbound: …, Notes: ….`*

(no entries yet — sprint started 2026-05-05)

---

## §7 Postmortem archive

One postmortem per completed sprint. Written at sprint end. Each entry: cluster, window, inputs attainment, threshold attainment, what worked, what didn't, decision (double down / pivot / pause), open questions.

(empty — no completed sprints yet)
```

### Step 3 — Update the CSV

The new columns go at the end of the row in this order: `rung`, `last_touch_date`, `next_move`, `next_move_due`.

1. Read the header line. Append `,rung,last_touch_date,next_move,next_move_due` to the end. Preserve any existing trailing field exactly.
2. For every existing data row, append `,,,,` (four empty fields) so column counts match the new header. Be careful with quoted fields — a row like `@handle,A,F,"context, with comma","action"` already contains commas inside quotes; the safe move is to append the four commas to the very end of the line, after any closing quote.
3. Preserve the file's existing line-ending convention (LF vs CRLF) and trailing newline.

If there are more than ~30 rows or any quoted fields look ambiguous, prefer a small Python one-liner over `sed` to avoid mangling. Example (read, mutate, write):

```python
import csv, sys
with open("growth/.local/jinn-warm-contacts.csv", newline="") as f:
    rows = list(csv.reader(f))
header, *data = rows
new_cols = ["rung", "last_touch_date", "next_move", "next_move_due"]
header += new_cols
data = [row + [""] * 4 for row in data]
with open("growth/.local/jinn-warm-contacts.csv", "w", newline="") as f:
    csv.writer(f).writerows([header] + data)
```

(Run only after confirming with Oak that the script's behaviour matches the file shape.)

### Step 4 — Verify, then hand off

Show Oak:
- The full new §6 + §7 blocks as they now appear in the file.
- The new CSV header line.
- The first 3 data rows of the CSV (post-update) so he can confirm column alignment.

Stop after that. Do **not** start backfilling rung values for existing rows — Oak will do that pass himself, segment by segment, since rung-assignment requires judgement (`touched` vs `warm` is ambiguous from prior_context alone).

### Step 5 — Smoke test (optional but recommended)

Invoke the `growth-day` skill. It should:
- Detect the active sprint in §6.
- Produce a brief with a SPRINT section showing day 1 of 14, inputs 0/6 teach, 0/1 bridge.
- Show "(none — queue clear)" or similar for READY TO ADVANCE since no rows have `next_move_due` yet.
- Append today's plan to §5 and a daily-progress line to §6.

If `growth-day` fails-loud despite §6 being present, re-read the sprint precondition (Step 1.5 of the skill) — likely the window dates are off, or §6 is malformed.

## What this prompt does NOT do

- Backfill `rung` values for existing CSV rows (Oak's call, per row).
- Set the bridge-post target cluster (deferred to first growth-day run).
- Update other skills (`twitter-strategy`, `growth-watcher`, `cluster-model`) that read the CSV — those still work on the legacy schema until they're updated separately.
- Touch `.claude/skills/growth-day/SKILL.md` — that already landed via PR.
