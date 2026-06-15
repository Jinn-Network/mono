# TypeScript Seller-Side Trajectory Scrub Stack

> Version: 0.1
> Date: 2026-06-15
> Author: Ritsu (drafted by Opus 4.8 during independent review of PR #1114)
> Status: Proposed (not yet adopted)
> Challenges: the 2026-06-05 amendment to `log/decisions/2026-05-07-otel-pipeline-unification.md` (DR-2026-05-07-e), which selected a daemon-managed **Go** OpenTelemetry Collector sidecar
> Relates to: PR #1114 ("[codex] Complete capture collector sidecar")

## Why this exists

PR #1114 implements the 2026-06-05 amendment: a daemon-managed native **Go** OTel Collector
sidecar that scrubs capture/trajectory data before publish. Independent review surfaced three
blocking issues (B1 dropped harness-bundle toggle; B2 `requireTrajectoryPipeline: true` hardcoded
while no build/CI produces the binary → published daemon fails closed on every task run; B3 the
"supervisor" never restarts a crashed collector) and one architectural concern: **the Go-sidecar
approach is the source of B2/B3 and is not idiomatic for this domain.**

Online research (2026-06) established:

1. **No comparable agent/LLM-trace product ships a collector binary to end users.** Langfuse,
   LangSmith, Helicone, Arize Phoenix, Braintrust, Traceloop/OpenLLMetry, OpenHands, and Claude
   Code itself all capture **in-process via a language SDK** and treat any collector as an
   *optional, server-side* component.
2. **The OTel Collector `redaction` processor ships with no built-in secret/PII patterns** — it is
   a regex allowlist/blocklist engine you configure. Its only hard-to-replicate edge is allowlist
   mode + provenance; it does **not** detect unknown secrets.
3. **A fully-local, no-binary, all-TypeScript scrub stack with real (ML-grade) detection is
   viable** — the premise that "real scrubbing needs Go or Python" is false as of 2026.

This spec defines that TypeScript stack as the alternative to the Go sidecar.

## Goal

Take rich agent-trace content (the product being sold) and remove the **seller's** secrets + PII
before publish — value-preserving, fully local (no cloud, no native binary), built from
maintained off-the-shelf components, with a signed provenance manifest. **Trust model:
seller-side scrub** (no buyer-side verification required yet; the manifest is a good-faith,
forward-compatible receipt).

## Architecture

A `ScrubPipeline` of ordered stages applied to each span's attributes/events **in-process in the
daemon**, before SQLite persistence and IPFS emit. Input is the existing JS OTLP receiver
(`client/src/trajectory/receiver.ts`) that ingests external tools (Claude Code, Codex, Gemini CLI,
…). This is the originally-ratified `DR-α` design (in-process OTel SDK pipeline) with a real
scrub — **no Go collector, no sidecar, no binary to ship.**

## Pipeline stages (ordered by cost ascending — each stage shrinks input for the next)

| # | Stage | Tool | Catches | Action |
|---|---|---|---|---|
| 1 | Structural key policy | config-driven | classifies each attribute key: `safe` (durations, model, token counts, span kind → pass raw), `content` (free-text → must scrub), `drop` (auth headers, env dumps, raw API bodies → delete) | gates what reaches stages 2–4 |
| 2 | Structured-PII regex | `openredaction` (570+ patterns + checksums) | credit cards (Luhn), SSNs, phones, IPs, crypto addresses | replace with `[PII:<type>]` |
| 3 | Secret detection | `@secretlint/core` (preset-recommend + OpenAI/Anthropic/AWS/GitHub rules) + Shannon-entropy heuristic | API keys, tokens, private keys, high-entropy blobs | replace with `[SECRET:<rule>]` |
| 4 | PII NER (ML) | `onnx-community/gliner_multi_pii-v1` via Transformers.js (quantized ONNX, Node, worker thread) | names, addresses, orgs, IDs the regex misses | replace/hash entity span |
| 5 | Identity/path scrub | existing Jinn scrubber | home dir, username, repo paths | keep as-is |

**Blocklist semantics** (remove the dangerous bits, keep the content) — *not* allowlist-drop,
since the content is the product. The structural key policy (stage 1) provides the allowlist-style
fail-safe at the *key* level without destroying free-text value.

## Provenance manifest (the legibility story — no Go binary needed)

Per published trajectory, emit a **signed** `redactionManifest` recording, per stage: component
**name + pinned version** (secretlint version, GLiNER model SHA, openredaction version, ruleset
hash), config hash, and redaction counts by type. Signed with the agent EOA (the code already
signs `redactionManifest`). This is *more* legible than "we ran a standard collector": it is a
per-artifact, signed, **reproducible** record, forward-compatible to buyer-side verification (a
future auditor re-runs the pinned stack and diffs).

## Failure posture → resolves B2 and B3

Fail-closed: if any stage errors or the model fails to load, the trajectory is **not** published.
Because the pipeline is in-process TS, **it is always present** — there is no external binary that
can be missing, so the "brick the daemon" failure mode (B2) and the "supervisor never restarts"
gap (B3) **disappear**.

## Dependencies (all npm, all local)

- `@secretlint/core` + `@secretlint/secretlint-rule-preset-recommend` (+ provider rules)
- `@huggingface/transformers` + pinned `onnx-community/gliner_multi_pii-v1` (one
  platform-independent ~50 MB quantized `.onnx`, fetched-once-and-cached or bundled — **not** four
  per-platform native binaries)
- `openredaction`

## Performance

GLiNER inference is the only real cost. Mitigations: structural pre-filter + regex/secret stages
shrink input → batch spans → quantized int8 model → run in a `worker_thread` (do not block the
daemon loop) → cap per-span text length. A trajectory is tens–low-hundreds of spans; scrub adds
seconds to a *publish* step (not a hot path). Acceptable.

## Impact on PR #1114

- **Deletes:** `otelcol/`, `client/src/trajectory/otel-collector/` (supervisor + config),
  `client/scripts/stage-otelcol.mjs`, the binary-distribution problem, B2, B3.
- **Keeps:** the JS OTLP receiver (external-tool ingest), the SQLite exporter, the publish path,
  the `redactionManifest`/provenance concept (upgraded).
- **B1** (dropped `includeHarnessBundle` toggle at `client/src/main.ts:1297`) still gets its clean
  fix regardless.

## Head-to-head vs. the Go sidecar (PR #1114)

| | Go OTel sidecar (PR) | TS scrub stack (this spec) |
|---|---|---|
| Secret detection | regex only, no built-in patterns | secretlint rules + entropy (+ optional TruffleHog) |
| PII detection | regex only | GLiNER ML NER + regex |
| Distribution | 4 native binaries, optionalDeps, supervisor | npm deps + one `.onnx`; in-process |
| B2 (brick risk) | present | gone (nothing to ship) |
| B3 (restart) | needs hand-rolled supervisor | n/a |
| Provenance | "ran standard component" | signed per-artifact reproducible manifest |
| Matches industry norm | no (no one ships a collector to users) | yes (in-process SDK) |
| Recall on unknown secrets/PII | lower (regex) | higher (ML + secret rules) |

## Honest gaps

- **No live-secret-verification** (TruffleHog's confirm-the-key-is-active) in pure TS. Optional
  hybrid: shell out to the *one* TruffleHog Go binary only to verify stage-3 candidates — a far
  smaller bundling job than a collector, and opt-in.
- **GLiNER recall is not 100%** (no detector is — Presidio disclaims the same). The layered
  secrets+regex+ML stack maximizes recall; fail-closed + signed manifest bound the residual risk.
- **Model file** adds ~50 MB (platform-independent, fetch-once) — trivial vs. four native binaries.

## Decision needed

This challenges a ratified DR amendment (2026-06-05, oaksprout), so it is a design/governance call,
not a code-review outcome. The open sub-questions for whoever owns that decision:

1. Is "we ran the standard versioned OTel component" worth the Go binary for the market trust
   story, given the signed per-artifact manifest is arguably *more* legible?
2. Is TruffleHog's live-secret-verification wanted badly enough to bundle one Go binary for that
   *specific* capability (much narrower than a collector)?
3. Model delivery: bundle the `.onnx` in the npm package, or fetch-once-and-cache on first run?

If neither (1) nor (2) clears the bar, the in-process TS stack is the simplest thing that actually
solves the seller-side scrub and dissolves B2/B3.
