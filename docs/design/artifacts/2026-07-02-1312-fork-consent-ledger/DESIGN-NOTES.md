# Design notes — 1312 · Harness first-run consent + contribution ledger

**Surface 1 · Harness TUI** (`jinn-layer`, a CLI coding-agent harness, fork of the Hermes agent). Terminal-rendered, keyboard-driven. Where data leaves the machine, the copy drops all brand metaphor and states exactly what happens.

Preview: [`1312-fork-consent-ledger.html`](./1312-fork-consent-ledger.html) — self-contained, interactive (click the console, drive it with the keyboard; state-jump chips above it).

Source: Claude Design project `frontends` (`019e2715-c4bc-7eae-af28-e178b95e5156`), file `1312-fork-consent-ledger.html`.

---

## The two hard rules, applied

- **No emoji, anywhere.** Status is word + colour, never a glyph. Even the "recorded" confirmation uses the word `recorded` and a coloured state label — no check-mark, per the brand's ban on `✓/✗` as UI icons.
- **Plain language on data-leaving-the-machine.** The consent screen never says *summon*, *vessel*, *smoke*, or *corpus of wishes*. It says "published to a public corpus", "scrubbed of secrets and personal data", "fails closed", "kept on this machine only". The vow-language returns only in the ledger's neutral chrome (`vessel-0x91be…` as the node id) — never on a consent, veto, or failure line.
- **Lead with the upside, in a flat tone.** Earlier drafts read as all-risk. Per the brand's "lead from structure, not fear", the screen opens with three plain benefits — the open harness, OLAS on verified contributions, the two-way corpus — before the safety mechanics. Stated clinically, not sold: no urgency, no exclamation, no marketing register.

## Consent flow — states & lifecycle

Consent is a three-value machine: `unset → accepted | declined`. The per-action lifecycle is `idle → confirming → recorded`, surfaced in the console footer.

- **unset** (idle) — the explainer: *why turn it on* (benefits) then *what leaves this machine* (safety). Keys: `A` accept · `D` decline · `P` preview · `?` docs. Default on bare `Enter` is **decline** — the safe default never publishes.
- **preview** (idle) — a real, scrubbed envelope from the last task. Reachable before any publish ever happens (requirement iv). Keys: `A` accept · `B` back.
- **confirm-accept / confirm-decline** (confirming) — one deliberate `Y/N`. Escape or `N` returns to unset.
- **recorded-accept / recorded-decline** (recorded) — states the resulting behaviour plainly, then the optional node stub.
- **node stub** — "Run a network node?" → `L` Later (points to docs) or `Enter` skip. Answer is always *later*; it never sets anything up here.

## Exact copy — consent

Opening line: *"jinn-layer is an open coding harness. When it finishes a task it can publish a scrubbed trace of that task to a public corpus — the shared record that trains the harness everyone runs."*

| Group | String |
|---|---|
| why · open harness | Build the open harness — your tasks improve the agent no one company owns. |
| why · rewards | Earn rewards — verified contributions earn OLAS. |
| why · two-way | Two-way — you read from the same corpus you feed. |
| what leaves · scope | Only traces of tasks this harness runs — never your machine, shell, files, or anything outside a task. |
| what leaves · scrub | Every trace is scrubbed of secrets and personal data here, first. If scrubbing can't finish, nothing sends. It fails closed. |
| what leaves · control | You can veto any task, and preview the exact payload before the first send. |
| decline | Decline and jinn-layer still works fully — as a reader. |

## Exact copy — confirmations & results

| Moment | String |
|---|---|
| confirm accept | Turn on contribution? Every task this harness runs will be scrubbed and published to the public corpus. You can veto any task and turn this off any time. [Y] Yes · [N] No |
| confirm decline | Decline contribution? The harness stays fully functional — it will read the corpus and publish nothing. [Y] Yes · [N] No |
| recorded · on | Contribution is ON. Scrubbed task traces will publish to the public corpus. Nothing publishes until after you preview once. |
| recorded · off | Contribution is OFF — reader only. No trace leaves this machine. Turn on any time: jinn-layer contribute --on |
| node stub | Run a network node? Running a node executes tasks for others and earns rewards. Separate setup; not needed to contribute or read. [L] Later — show docs · [Enter] Skip |
| node stub → later | See docs.jinn.network/run-a-node when you're ready. Nothing to do now. |

## Ledger — columns, tiers, state messages

Command: `jinn-layer ledger`. Columns: **time**, **task**, **envelope** (content-addressed ref), **anchor** (short on-chain tx hash), **tier**. Verifiability tier is a status chip in three levels of confidence:

- `user-accepted` — the operator marked the task complete; no automated check. Lowest tier — rendered **sky**.
- `tests-passed` — the task's own test suite passed. Rendered **green**.
- `evaluator-verified` — a SolverNet evaluator scored it under bond. Highest tier — rendered **gold**.
- **vetoed (local only)** — withheld; envelope + anchor show `—`. Rendered **amber**.
- **publish failed — retained locally** — the one state message. Envelope assembled, anchor not written; a sub-line offers `[r] retry` and `[v] veto instead`. Rendered **red**.

**Empty state:** "Nothing published yet. Traces appear here after your first task publishes. Vetoed and retained-local tasks are listed too."

**Veto confirmation** is honest about the limits of removal: a not-yet-published task simply won't send; an already-published one can be pulled from the corpus index and de-served, but copies others already trained on can't be recalled. Stated plainly, not softened.

## Open questions (flagged, not decided)

- Does `preview` need its own network fetch, or is the "last task" always available locally at first run (before any task has run, there is nothing to preview)? Assumed: on a truly fresh machine with zero tasks, `P` shows a representative fixture labelled "example — no task run yet" rather than an empty preview. Confirm with harness owner.
- Whether declining should still show the node stub. Assumed yes — running a node is orthogonal to contributing traces. Flagging in case product wants the stub only on accept.
- Anchor-tx column for `user-accepted` tier: is an un-evaluated trace anchored at all, or only indexed in the corpus? Shown here as anchored (every published envelope gets an anchor tx; the tier reflects verification, not anchoring). Confirm against SPEC anchoring model.
- Ledger pagination / windowing for long histories (shown here as a single scroll). Out of scope for the mock; flag for implementation.
