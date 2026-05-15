- **Date:** 2026-05-08
- **Author:** Oak (with Claude)
- **Status:** Proposal
- **Version:** 0.1
- **Discussion:** [#120](https://github.com/Jinn-Network/mono/discussions/120)

## Motivation

`BRAND.md` governs every user-facing artifact but does not yet govern the smallest one: how Jinn introduces itself in ≤160 characters. Twitter bios, link previews, conference one-liners, podcast chyrons, slide footers, and the first sentence of any cold outreach all draw from the same well — and at present that well is improvised per-surface.

A canonical introduction is the appropriate response, for the same reason every other voice rule lives in `BRAND.md`: a headless brand needs Schelling points so independent operators converge on a shared self-description without enforcement.

The bio question prompted a competitor cross-check (Bittensor, Olas, Virtuals, Allora, Numerai, Prime Intellect). The check surfaced two findings worth canonising alongside the bio itself:

1. Most "decentralised AI", "training", "self-improving", and "collective intelligence" framings are taken. Jinn cannot lead from any of them without sounding me-too.
2. The white space Jinn can credibly hold is narrower and more specific: **economy** as the category noun (vs. marketplace / stack / layer / network), **solve** as the verb (vs. train / predict / aggregate / orchestrate), and the network-runs-without-us property (none of the six competitors can credibly claim it).

The bio falls out of those two findings. Codifying the analysis alongside the bio gives future copy a check the existing voice rules don't currently provide.

## Proposal

Three additions to `BRAND.md`. No deletions, no reorganisation of existing sections.

### 1. New section: Canonical introduction

Inserted after the existing `## Voice` block and before `## Posture: headless and co-created`.

```markdown
## Canonical introduction

The smallest user-facing artifact Jinn ships is its self-description in ≤160 characters. Treat the canonical line as a Schelling point in the same sense the loop and the lexicon are: forkable surfaces converge on it because the cost of fragmentation outweighs the upside of a personal variant, not because anyone is enforcing it. The line is canon, not protocol — proposing a replacement is a normal canonical-doc PR, not a structural change.

> The decentralised economy where agents learn to solve. As your agent learns, the network learns.

This line travels everywhere Jinn is introduced in compressed form: X bio, link previews, conference chyrons, slide footers, the first sentence of cold outreach, the lede of explainer posts. Operators producing user-facing surfaces should converge on it; if a community-driven variant gains real adoption, propose it as a replacement here rather than ship a quiet alternative.

Longer canonical formats (one-sentence, one-paragraph, one-page) are deferred to a future spec — likely paired with `THESIS.md` once that doc is populated.
```

### 2. New voice rule: Stake-claiming and white space

Inserted as a third subsection under `## Voice`, after `### Lead from structure, not from fear`.

```markdown
### Stake-claiming and white space

Most positioning vocabulary in the decentralised-AI cluster is already owned. Leading from a phrase a competitor has earned reads as imitation, regardless of intent.

Crowded territory — avoid leading copy with these phrases:

- **"Decentralised network for AI"** — Bittensor.
- **"Decentralised training"** / **"Open Stack for Self-Improving Agents"** — Prime Intellect.
- **"Self-improving"** / **"collective intelligence"** / **"intelligence layer"** — Allora.
- **"Co-own AI"** / **"unified network for off-chain services"** — Olas.
- **"AI agent launchpad"** / **"tokenise agents"** — Virtuals.
- **"Encrypted data"** / tournament framing — Numerai.

White space Jinn plants in:

- **Economy** as the category noun (not marketplace, stack, layer, or network).
- **Solve** as the verb (not train, predict, aggregate, or orchestrate).
- **Outcomes** as the noun for what gets solved.
- The **network-runs-without-us** property — only Jinn can credibly stress-test this; the six competitors above are all VC-backed companies, multisigs, or hedge funds.

How to apply: when writing positioning copy, run a thirty-second collision check against the territory above. If the lead phrase belongs to a competitor, refactor before publishing. If a desired claim sits in their territory, demote it — subordinate clause, second sentence, or move it to a downstream artifact entirely. The competitive landscape moves; revisit this list on the same cadence as canonical-doc reviews.
```

### 3. New appendix: Orphan claims and assigned homes

Appended at the end of the document, after `## Visual sidecar`.

```markdown
## Appendix: orphan claims

Strong claims that the canonical introduction deliberately does not carry. Each has an assigned home so the bio does not sprawl and the claim does not go homeless.

| Claim | Lives in |
|---|---|
| "Solve any problem" — the ambition | `THESIS.md` (when populated) and pinned X post |
| "Open data" — system property of the loop | Long-form pitch / explainer thread / docs |
| "Bonded / staked economy" — operator lens | Operator-recruitment copy, runbook intro |
| "Go alone fast, go together far" — culture line | Manifesto opener, closing line of thesis posts |

Bio names what Jinn is. Properties live one click deeper.
```

## Scope and non-goals

In scope:

- The three `BRAND.md` additions above.
- A single PR linking this spec, with the GitHub Discussion required by `spec/2026-04-28-canonical-docs.md` for canonical-doc changes.

Not in scope:

- `THESIS.md` changes. The "solve any problem" ambition wants a permanent home there but `THESIS.md` is currently a stub; populating it is a separate spec.
- `GROWTH.md` changes. This proposal is voice canon, not a campaign or channel decision.
- Visual updates. The bio is voice; visual canon is unchanged.
- Lexicon changes. Vow-language is untouched.
- Longer canonical formats (one-sentence, one-paragraph, one-page). Deferred per the canonical-introduction section above.

## Risks

- **Bio drift.** Operators producing surfaces in the wild may drift the wording. Mitigation: canon is the Schelling point, not enforcement; if a community variant gains real adoption, propose it as a replacement.
- **Competitor positioning shifts.** Prime Intellect or Allora could move into "decentralised economy" or "solve" territory. Mitigation: the white space named here is current, not eternal — re-check on the canonical-doc review cadence.
- **Bio adjacency to Allora.** "As your agent learns, the network learns" sits next to Allora's *self-improving decentralised AI network* frame. Mitigation: the first sentence already plants Jinn on different ground (economy vs. intelligence layer; solve vs. predict), so the second sentence is parallel-not-confused. Acceptable as-is; revisit if Allora's framing shifts.
- **List rot.** The "crowded territory" list becomes stale as competitors pivot. Mitigation: explicit re-check cadence noted in the rule itself.

## Rollout

Single PR:

- This spec at `spec/2026-05-08-brand-canonical-introduction.md`.
- `BRAND.md` — three additions per the Proposal section above.
- Linked GitHub Discussion (per canonical-docs policy) created when the PR opens; this spec is the long-form upstream reasoning the discussion can point at.

The X bio itself is updated in the same operational beat the PR lands. The PR is the canonical record; the actual deployment is a one-line copy paste into the @jinn account bio.

## Open questions

- **Bundle with `THESIS.md` population?** "Solve any problem" wants `THESIS.md`. If `THESIS.md` is being populated within the same week, bundling avoids two passes through the canonical-docs gate. If not, this spec ships standalone and the ambition claim lives temporarily in pinned-post-only.
- **Competitor list maintenance.** Where does the "crowded territory" list get re-checked — annually, on each new competitor surfacing, or on each canonical-doc review? Proposed: on canonical-doc review cadence, with ad-hoc updates allowed via standard PR (no spec needed for adding/removing one phrase).
- **Bio variants for non-X surfaces.** A 160-char limit drives the current line. LinkedIn, GitHub, podcast bio fields may have different limits. Open: do those get their own canonical lines, or do they all converge on the same one and accept truncation? Proposed: same line, accept truncation; revisit if a surface materially under-delivers because of it.
