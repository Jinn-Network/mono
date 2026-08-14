<!-- SPDX-License-Identifier: CC-BY-NC-4.0 -->

# Licence review brief: LoCoMo judge report

**Status:** questions for operator/counsel; not legal advice or clearance<br>
**Requested disposition:** cleared, cleared with conditions, or not cleared for each use below<br>
**Public actor:** `ritsukai`<br>
**Publication:** free contribution artifact; no posting is authorized by this brief

## 1. Proposed activity

The project would privately prepare and later publicly release a pre-registered report about grading-instrument behavior on a few hundred LoCoMo-derived question/reference/candidate records. It would not publish the full 1,540-question Category 1-4 set or full conversation transcripts. The planned public bundle includes selected question/reference/candidate text, corrected-key annotations, human rationales, evidence locators, prompts/configuration, grader outputs, statistical summaries, code/fixture digests, attribution, and verification material.

The report is free and intended as a contribution artifact, not a revenue artifact. It may nevertheless appear on or be associated with a commercial Colophon/Jinn project surface. Free price alone is not treated as proof of a NonCommercial purpose.

## 2. Observed source posture

| Source | Planned use | Observed licence posture requiring confirmation |
|---|---|---|
| `snap-research/locomo` pinned release | dataset questions, references, source evidence, original deterministic-evaluator provenance | repository root carries CC BY-NC 4.0; no separate code licence was found |
| EverMemOS pinned judge | Arm A prompt/parser provenance and possible copied prompt/code | Apache License 2.0 |
| `dial481/locomo-audit` | motivating rates and provenance; stress material only with active permission | repository contributions state CC BY-NC 4.0; imported prompt has an Apache provenance notice |
| historical/current Mem0 harnesses | provenance context only under recorded R1 | Apache License 2.0 |
| Zep paper harness | provenance citation only under recorded R1; no copying | inspected repository states CC BY-NC-SA 4.0 |
| this design packet and derived labels | local drafting and intended free release | file-level `CC-BY-NC-4.0` inside an Apache-2.0 monorepo |

Pinned commits and source links are listed in `DESIGN.md` §24. Exact copied-file licence and NOTICE bytes must join the final source register.

## 3. Decisions requested

| ID | Question requiring a written answer | Why it matters | Disposition |
|---|---|---|---|
| LR-1 | Is this specific free report and bundle a permitted NonCommercial use when hosted or promoted from the actual Colophon/Jinn surface? | Hard publication gate; purpose and context may matter despite a zero price. | `[REQUIRED]` |
| LR-2 | May the selected LoCoMo questions, released references, authored candidates, corrected references, labels, and evidence locators be redistributed together under CC BY-NC 4.0? | Defines the public derivative-work boundary. | `[REQUIRED]` |
| LR-3 | Must selected source excerpts remain locator-only, or may short transcript/caption excerpts appear in evidence packets and public rationales? | Determines whether the public bundle can be self-contained or must resolve evidence from the pinned source. | `[REQUIRED]` |
| LR-4 | May CC BY-NC files remain in this Apache-2.0 monorepo if the directory has file-level SPDX notices and a separate bundle licence/NOTICE? | Hard merge/package gate; avoids suggesting Apache relicensing of derived material. | `[REQUIRED]` |
| LR-5 | What exact attribution, source link, licence link, change notice, creator name, disclaimer, and provenance wording is required for LoCoMo-derived material? | Required release metadata and report front matter. | `[REQUIRED]` |
| LR-6 | Is original LoCoMo evaluator code covered only by the repository's root CC BY-NC licence, and should it be cited without redistribution? | Controls whether deterministic-F1 code can ship or only its behavior can be described. | `[REQUIRED]` |
| LR-7 | Does copying the pinned EverMemOS prompt/parser require the complete Apache-2.0 licence, NOTICE handling, and modification notice in the bundle? | Controls Arm A packaging. | `[REQUIRED]` |
| LR-8 | Are corrected reference keys, essential-fact atoms, and human rationales distributable as CC BY-NC derivative annotations? | Hard gate for the central reusable contribution. | `[REQUIRED]` |
| LR-9 | If dial481 participates, what explicit permission and credit must be obtained before reusing or transforming their candidate answers or 99-error annotations? | Selects Variant W scope; absent permission the design uses Variant N. | `[REQUIRED FOR VARIANT W; N/A FOR N]` |
| LR-10 | Does citing, without copying, the CC BY-NC-SA Zep harness create any ShareAlike obligation for this report? | Confirms the recorded provenance-only boundary. | `[REQUIRED]` |
| LR-11 | May raw model outputs that discuss LoCoMo-derived inputs be included under the planned bundle terms, subject to provider terms and PII review? | Controls publication of grader and shadow outputs. | `[REQUIRED]` |
| LR-12 | What privacy/PII threshold applies to selected conversational questions, references, captions, evidence locators, and model rationales? | Controls pre-publication redaction or deterministic item replacement. | `[REQUIRED]` |

## 4. Proposed conservative packaging for review

Subject to approval, the release would use a clearly bounded CC BY-NC directory or separate repository containing:

- a dedicated `LICENSE` for CC BY-NC 4.0 and a plain-language NonCommercial notice;
- an attribution and modification table for every source;
- Apache-2.0 licence/NOTICE material for copied EverMemOS bytes;
- no copied Zep harness bytes;
- no dial481 stress candidates or error annotations without explicit participation permission;
- selected records only, never the full LoCoMo dataset;
- evidence locators rather than full conversation transcripts by default;
- a PII scrub and replacement ledger; and
- an explicit statement that the report is unaffiliated with and not endorsed by benchmark or harness authors unless separately confirmed.

## 5. Requested sign-off record

| Field | Value |
|---|---|
| Reviewer name/role | `[REQUIRED]` |
| Review date | `[REQUIRED]` |
| Approved host/repository boundary | `[REQUIRED]` |
| Approved licence and attribution package | `[REQUIRED]` |
| Conditions or prohibited uses | `[REQUIRED]` |
| Re-review trigger | `[REQUIRED]` |
| Signature or commit identity | `[REQUIRED]` |

Until this record is completed, no merge into an ambiguously licensed boundary and no public release occurs. Private design work may proceed only to the extent the reviewer confirms it is permitted.
