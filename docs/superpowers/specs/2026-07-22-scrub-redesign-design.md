# One trustworthy scrub for public knowledge — PII/secrets scrub redesign

- **Version:** 0.2 (v0.2 folds in the 2026-07-22 corpus-mining PII inventory: D3 hostname evidence, two measured precision hazards, eval-weighting caveat)
- **Date:** 2026-07-22
- **Author:** Claude Fable 5 (drafted, design session); Ritsu (design direction)
- **Shape:** `design` — output is this spec; implementation lands via the follow-up issues in §9, not in this session
- **Supersedes (on adoption):** the profile-split portion of `spec/2026-06-15-ts-trajectory-scrub-stack.md` (stage inventory and failure posture carry forward; the strict/seed division does not)
- **Evidence base:** issues [#1784](https://github.com/Jinn-Network/mono/issues/1784), [#1959](https://github.com/Jinn-Network/mono/issues/1959), the #1372/#1391 denylist lineage, a 2026-07-21 operator-local scrub stress test over real episodes (`~/.jinn-client/local-corpus/scrub-findings.md`), and a 2026-07-22 operator-local mining inventory over 10 autopilot hermes-home state stores (`~/.jinn-client/local-corpus/mining-batch1-pii-inventory.md`). Both evidence files stay operator-local; this spec references them by class and count only, never quoting PII

## 1. Summary

Traces from agent sessions are curated into evidence records and published to a public,
content-addressed, on-chain-anchored substrate. A leak there is effectively irreversible; an
over-redacted corpus is worthless. The scrub is the safety gate between the two failure modes,
and today it fails both directions at once:

- The **strict profile** defaces ordinary technical prose (issue #1784: "claim registration"
  detected as a health-insurance claim, "misconfiguration" as an emergency medical incident, a
  six-digit test pid as five different license-plate/ID classes).
- The **seed profile** passes 40-hex `0x…` wallet addresses verbatim to the public substrate
  (issue #1959).
- **Neither profile catches a bare personal name** — 0/4 machine recall on real git-identity
  content in the operator-local stress test, against 4/4 for the emails sitting beside those
  names. A committer's name next to its redacted email stays visible.

The root cause is structural, not a patch gap: detectors are selected **per lane** (strict
vs. seed) instead of governed **per class**, so dropping the noisy openredaction stage from the
seed lane also dropped the one deterministic, zero-false-positive detector it happened to
contain (ETH addresses). Meanwhile the subtractive "generic 570-pattern scanner + ever-growing
denylist" approach has consumed four issues (#1331, #1348, #1372, #1391), denylisted 60+
patterns, and a fresh stress test immediately found ~10 more. It does not converge.

This spec designs the replacement from first principles:

1. **One scrub.** A single detection pass with a per-class detector inventory that never
   varies by destination. What varies is **disposition** (auto-redact / reject-publish /
   flag-for-review / pass), expressed in one explicit policy table, not divergent pipelines.
2. **Detectors are governed by confidence class**, Presidio-style: deterministic shapes
   auto-redact; contextual detectors carry confidence scores boosted or suppressed by
   context; an ML tier (GLiNER-family, run locally) covers free-prose names the regexes
   provably cannot.
3. **Names get a deterministic carrier tier.** Most names in traces arrive through
   structured carriers (`Author:` / `Co-Authored-By:` / `Signed-off-by:` lines, home paths,
   `git config` output) that are regex-detectable at high precision — the ML tier is the
   backstop for free prose, not the primary mechanism.
4. **A measured evaluation harness** over real (operator-local) traces is the acceptance
   gate, with per-class recall/precision targets. Automation of any human-review step is
   licensed by measured recall, not by assumption.
5. **Fail closed, and prove it**: publish the policy hash and per-class redaction counts in
   the envelope's redaction manifest so a fetched envelope can attest which scrub ran —
   closing today's gap where "a fetched envelope cannot by itself prove which scrub profile
   ran" (`packages/core/src/scrub/build.ts`).

Both operator positions under test survive, with refinements stated in §4. The tactical
coupled fix (#1959 + #1784 residuals) should land **now**, ahead of this redesign — §8.1.

## 2. Where the current pipeline stands

Code: `packages/core/src/scrub/`. One `ScrubPipeline` (ordered stages over attribute bags,
nested-value walking, redaction records) instantiated in **three profiles**:

| Profile | Builder | Stages | Consumers | Mode |
|---|---|---|---|---|
| strict / trace | `buildScrubPipeline()` | keyPolicy → openredaction → plainPatterns → secretlint(+entropy) [→ mlPii if enabled] | daemon capture/trajectory publish (`client/src/captures/publish.ts`, `main.ts`, engine) | redact |
| seed | `buildSeedScrubPipeline()` | keyPolicy → plainPatterns(credentialIds) → secretlint(no entropy) | seed-import skill + episode lanes (`packages/layer/src/seed-import/`) | redact + refuse-on-detection |
| layer-2 | `buildLayer2ScrubPipeline()` | keyPolicy → plainPatterns(credentialIds) → secretlint(full) | distillation check (`layer2.ts`) | check (reject on any hit) |

Status of the moving parts:

- **openredaction stage** (strict only): the library's 570+ patterns minus a 60+-entry
  denylist accumulated across #1331/#1348/#1372/#1391. The denylisted patterns share one
  pathology — an ordinary English trigger word plus a bare `[A-Z0-9]{n,m}` tail — and the
  2026-07-21 stress test found ~10 more undenylisted types firing on words like
  "participate", "misconfiguration", "invisible", "ambiguous" and on a six-digit test pid
  (live repro on #1784).
- **plain-patterns stage** (both): deterministic email + home-path regexes; seed adds
  AWS/GCP credential-ID prefixes (#1415). These work: 4/4 email recall, home-path usernames
  stripped in every profile.
- **secretlint stage** (both): pass-1 provider rules; pass-2 Shannon-entropy fallback (trace
  and layer-2 only) with an elaborate hand-tuned token-shape gate (path carve-out #1348,
  structured-segment and wordish gates #1391, non-ASCII skip, SWE-rebench ID skip).
- **ML PII stage**: exists (`ml-pii-stage.ts`, `transformers-detector.ts`) but is
  **off by default** (`captures.piiDetection.enabled: false`), never part of the seed
  profile, and wired to `Xenova/bert-base-NER` — a CoNLL-2003 newswire model with
  PER/ORG/LOC classes — rather than the PII-specialized GLiNER model the 2026-06-15 spec
  called for. In practice: unwired.
- **Failure posture**: fail-closed at publish altitude (shipped, correct — keep).
- The episode lane on `next` runs the seed profile since PR #1856; #1784 stays open on its
  live-publish acceptance criterion, and #1959 documents the wallet-address leak that the
  profile switch exposes.

Empirical recall/precision on real content (operator-local stress test, 2026-07-21; classes
and counts only):

| Class | strict | seed | note |
|---|---|---|---|
| Emails (4 real instances) | 4/4 | 4/4 | plain-patterns |
| Home-path usernames (35–179/episode) | caught | caught | plain-patterns |
| Wallet addresses (3–8 distinct/episode) | caught | **0 — verbatim leak** | #1959 |
| Bare personal names (4 real instances) | **0/4** | **0/4** | ML tier unwired |
| Ordinary prose (4 curated seeds) | **all defaced** | clean | #1784 |

## 3. Threat model

### 3.1 What can transit a trace

Trace content is mostly code and tool output, but the channel is unconstrained: user
prompts, pasted logs and documents, `git` output (author identities), shell output
(`whoami`, `env`, paths), error messages, URLs, config dumps. The autopilot capture lane
(~30 uncaptured trajectories already queued under `~/.jinn-client/autopilot/hermes-homes/`,
2.4 GB) will push arbitrary session content through this gate at increasing volume with no
per-item human author. Design for what *can* appear, not what usually does (§4.2).

### 3.2 Class inventory

Costs are asymmetric per class, which is why disposition must be per-class. "Leak cost" is
the cost of a false negative on an irreversible public substrate; "over-redaction cost" is
the knowledge destroyed by a false positive (a defaced corpus fails Learning Maximised; a
corrupted commit SHA or protocol address also fails Legibility — the receipt no longer
verifies).

| # | Class | Leak cost | Over-redaction cost | Detectability | Target (recall / precision) | Disposition at high conf. |
|---|---|---|---|---|---|---|
| A1 | Provider-prefixed secrets (`ghp_…`, `sk-…`, `AKIA…`, `AIza…`, `xoxb-…`, `npm_…`, ssh key blocks, JWTs) | Critical — account compromise, revocation is the only remedy | ~0 (no knowledge value) | Excellent (fixed prefixes/structure) | ≥ 0.99 / ≈ 1.0 | auto-redact |
| A2 | Unprefixed high-entropy secrets (random hex/base64, passwords in assignments) | High | Medium — commit SHAs, digests, container IDs look similar and are knowledge-bearing | Moderate (entropy + assignment/keyword context) | ≥ 0.90 / ≥ 0.95 | auto-redact above band; flag in band |
| A3 | Credentials embedded in URLs (userinfo, `?token=…`, `?key=…`) | High | Low | Good (URL structure) | ≥ 0.95 / ≥ 0.95 | auto-redact |
| A4 | Private keys & wallet mnemonics (64-hex keys in key context; BIP-39 12/24-word runs) | Catastrophic — funds | ~0 | Good (wordlist check, length + context) | ≥ 0.99 / ≥ 0.9 | **reject publish** (see below) |
| A5 | Env-block dumps (`KEY=value` line runs inside tool output — the content-level twin of the `env.*` key-policy drop) | High (bundles many secrets) | Low (env dumps are rarely the knowledge) | Good (line-shape) | ≥ 0.9 / ≥ 0.9 | drop block / reject |
| B1 | Email addresses | High — identity + spam surface; third-party addresses from git output are other people's data | Low | Excellent | ≥ 0.99 / ≥ 0.95 | auto-redact |
| B2 | Personal names — in structured carriers (`Author:`, `Co-Authored-By:`, `Signed-off-by:`, `git config user.name`, contact-sig lines) | High — defeats the email redaction beside it | Low in carrier context | **Excellent** (the carrier is the shape) | ≥ 0.95 / ≥ 0.95 | auto-redact (name+email jointly) |
| B3 | Personal names — free prose | High (third party), medium (operator pseudonym linkage) | **High** — library authors, product names, code identifiers misread as names deface content | Poor for regex (proven #1331); fair for PII-tuned NER | ≥ 0.80 flag-or-redact / FP budget per §7 | auto-redact ≥ T_auto; flag in [T_flag, T_auto) |
| B4 | Usernames/handles (unix users, GitHub logins, social handles) | Medium — linkage | High — repo coordinates (`github.com/<org>/<repo>`, `@scope/pkg`) are load-bearing public knowledge | Home-path form: excellent (shipped). Bare form: poor (proven #1331) | carrier-based only; free-form flags | carrier auto-redact; otherwise flag |
| B5 | Phone numbers | High | Medium — version strings, timestamps, ports, issue numbers collide | Good with validation (libphonenumber) + context | ≥ 0.9 / ≥ 0.9 | auto-redact validated; flag bare |
| B6 | Physical addresses | High | Medium | ML-only | ≥ 0.7 flag | flag |
| B7 | Government IDs / payment cards / bank accounts (SSN, card + Luhn, IBAN + mod-97) | Critical for the subject | Low–medium (bare digit runs are usually pids/ports/issues — see §4.2) | Checksummed forms: excellent. SSN-shape: weak alone, good with context | checksummed ≥ 0.99 / ≈ 1.0; SSN ≥ 0.9 with context / ≥ 0.9 | checksummed auto-redact; context-gated otherwise |
| C1 | Wallet addresses (`0x` + 40 hex) | High — permanent financial-graph linkage; third-party addresses are other people's financial identity | Medium — **known protocol addresses are knowledge** (JinnRouter, OLAS token, staking contracts); redacting them breaks the trace's verifiability | Excellent (shape; EIP-55 mixed-case checksum where present). `0x` prefix disambiguates from bare 40-hex git SHAs, which must survive | ≥ 0.99 / ≥ 0.99 (with allowlist) | auto-redact unless instance-allowlisted (§6.4) |
| C2 | Transaction hashes (`0x` + 64 hex) | Low–medium — public chain data, but links trace to operator activity beyond the anchor itself | Medium — receipts are Legibility material | Excellent (shape) | policy question — §10 Q1 | flag (default) pending Q1 |
| D1 | Home paths / usernames in paths | Medium | Low (tail of the path survives) | Excellent (shipped) | ≥ 0.99 / ≥ 0.99 | auto-redact (shipped behavior) |
| D2 | IP addresses | Public IPs: medium–high (location/infra). Loopback/private/reserved: ~0 and **often illustrative config content** | High for loopback (config examples are knowledge) | Excellent (shape + range classification) | public ≥ 0.95 / ≥ 0.95 | public auto-redact; loopback/reserved pass; private-range flag |
| D3 | Hostnames, machine names, device serials | Medium | Medium | Poor–fair in free text; **excellent via structured carriers** (attempt-manifest `host` fields, `os.hostname()` sources) | carrier ≥ 0.95 / ≥ 0.95; free-text flag-only | carrier auto-redact; free-text flag |
| E1 | Third-party document content (pasted customer data, medical/financial text) | High–critical | Medium | ML/document-class tier | ≥ 0.7 flag | flag; auto-redact only high-confidence sub-spans |

Notes:

- **Reject classes (A4, A5).** A private key or a full env dump in a trace means the
  capture is compromised beyond span-level repair; the correct action is to abort the
  publish and surface the failure loudly, not to redact and continue. This generalizes the
  key-policy `drop` tier from keys to content.
- **Git SHAs are a protected class in the other direction**: bare 40-hex (no `0x`) and
   7–12-hex short SHAs are provenance receipts. Any detector whose pattern can swallow them
  (entropy fallback, hex-shape rules) must carry an explicit carve-out, and §7's corruption
  metric counts them.
- **D3 is now a measured leak, with a structured carrier** (2026-07-22 mining inventory):
  a device hostname published through a v2 attempt-manifest `host` field is machine-uncaught
  by both shipped profiles. The carrier is a *key*, so the fix is key-policy tier
  (drop/redact the manifest `host`-type keys deterministically), not a content regex.
  Free-text hostname regexes carry a measured precision hazard: a naive `*.local` rule
  matches the Yarn version string `0.0.0-use.local` 11–21 times per mined review-home —
  free-text hostname detection stays in the flag band.
- **Variable names are not secrets — literals are** (A2 precision hazard, measured): the
  mined autopilot homes contain zero literal provider tokens but heavy legitimate use of
  env-var *references* in credential-handoff shell (`$GH_TOKEN`-style). A rule keyed on the
  variable *name* would have fired 49–230 times per review-home with zero true positives.
  A2's context words boost confidence only for candidate *values*; an env-reference shape
  in value position is counter-evidence, never a hit.

### 3.3 Where human review is load-bearing — and how it shifts with scale

Today (measured): the human curator is the **only** thing standing between the public
substrate and (a) every personal name, (b) wallet addresses on the seed lane. That is what
the stress test means by "the curator is load-bearing."

Under this design the load-bearing set shrinks to what genuinely needs judgment:

| Decision | Today | After redesign |
|---|---|---|
| Names in git-identity carriers | human | deterministic tier (B2) |
| Wallet addresses | human (seed lane) | deterministic tier + instance allowlist (C1) |
| Names in free prose | human | ML tier ≥ T_auto auto-redacts; [T_flag, T_auto) → review queue |
| Handles-as-person vs repo coordinates | human | review queue (flagged) |
| Entropy-band ambiguity (A2 band) | silent pass or silent redact | review queue |
| Curation judgment (is this good knowledge?) | human | human — out of scrub scope, stays in the curated-batch gate (`humanCurationRequired: true`) |

Scale rule: **automation per class is licensed by the eval harness, not by policy fiat.** A
class moves from flag-for-review to auto-disposition only when measured recall on the
operator-local benchmark meets its §3.2 target across consecutive releases. Review itself
shifts shape with volume: per-item full-read (hand-curated seeds, today) → exception-based
(review only flagged spans) → sampled QA (audit N% of auto-dispositioned items + all
flags) for the autopilot lane. Every review decision is recorded and becomes a labeled
example, growing the benchmark (§7) — the human's work compounds instead of repeating.

## 4. The two operator positions, tested

### 4.1 "One scrub, not modes" — validated, with a refinement

The invariant that must not vary by destination is the **detector inventory** — the same
threat model (same classes, same public substrate) applies to a trace, a seed, and a
distilled skill. The current split violates exactly this: strict-vs-seed selects *detector
families* per lane, so a lane decision (drop the noisy openredaction stage) silently
dropped a zero-false-positive deterministic class (ETH addresses) that happened to live
inside the same npm package. #1959 is not a tuning bug; it is the profile split working as
designed. Precision problems are per-detector; fixing them by per-lane subtraction is the
wrong axis, and the denylist history (#1331 → #1348 → #1372 → #1391 → ~10 more found
2026-07-21) is the empirical record of that axis not converging.

Refinement that survives first principles: destinations do legitimately differ in **what
happens on a hit** — a distillation check wants to reject and re-derive rather than publish
redacted output; a curated seed lane wants to refuse-and-fix; the trace lane wants to
redact and publish. That difference is *disposition*, and it belongs in one explicit,
versioned policy table (§6.5), not in divergent stage lists. The existing check-mode
consumers collapse to a one-line mapping: any non-`pass` action → reject. So: **one
detection pass, one detector inventory, one policy table; profiles cease to exist as
pipelines.** If a future destination genuinely needs a different threshold, that is a
policy-table row with a rationale, reviewable in one place.

The seed profile's implicit premise — "a human reviewed this, so probabilistic detection is
unnecessary" — is also made explicit and inverted: detection always runs; a human review
**resolves flags** (recorded in provenance) rather than replacing detection. Humans are
excellent curators and demonstrably poor exhaustive scanners; the 2026-07-21 findings show
hand-reviewed episodes still carrying third-party identities.

### 4.2 "No domain-allowlist shortcut" — validated; the domain prior survives as thresholds, not exemptions

"Coding traces don't contain X" is not a safety argument — the measured traces contain git
identities, third-party emails, and wallet addresses, and the channel admits arbitrary
pastes. No class is exempted by content-domain reasoning.

What the domain prior *is* legitimately used for is **precision policy**: a bare six-digit
number in trace content is overwhelmingly a pid, port, or issue number, so the
*confidence* that a bare digit-run is an SSN/plate/ID is low → its disposition lands in
flag-or-pass, never silent auto-redaction (this is precisely the #1784 pid false-positive,
solved at the right layer). The class stays in the inventory; the domain shapes its
thresholds and context requirements.

Allowlisting is also legitimate at the **instance** level, never the class level: a
specific verifiably-public value (the JinnRouter address, the OLAS token address, loopback
IPs, the repo's own slug) may be exempted by an auditable allowlist entry with provenance
(§6.4). "This instance is public" is checkable; "this class can't appear" is not.

## 5. Survey of existing solutions

Constraint applied throughout: **traces must not leave the machine to be scrubbed** — any
cloud-inference dependency is disqualified for the scrub path regardless of quality, and so
is any "verification" step that transmits candidate secrets to third-party endpoints.

### 5.1 Detection engines

**Microsoft Presidio** ([architecture](https://microsoft.github.io/presidio/analyzer/),
[context enhancement](https://microsoft.github.io/presidio/tutorial/06_context/)) — Python,
MIT. The reference architecture for this problem: a **recognizer registry** where each
recognizer (regex, checksum, NER, custom) returns results with **per-result confidence
scores** and an explainable decision trace; a **context enhancer** (LemmaContextAwareEnhancer)
boosts confidence when context words appear near a match (regex recognizers score ~0.85
baseline, 1.0 with checksum; context adds a bounded boost); allow/deny lists; pluggable NER
backends (spaCy default, transformers, stanza). Weaknesses for us: Python runtime (the TS
stack decision in `spec/2026-06-15-ts-trajectory-scrub-stack.md` stands — no sidecar
runtime to ship and supervise), and its default NER is newswire-trained (same technical-text
precision problem as bert-base-NER). **Verdict: adopt the architecture — recognizer
contract, confidence + context scoring, explainability — implement in TS. Do not adopt the
runtime.**

**Google Cloud Sensitive Data Protection (DLP)**
([likelihood customization](https://cloud.google.com/dlp/docs/creating-custom-infotypes-likelihood),
[hotword rules](https://cloud.google.com/dlp/docs/samples/dlp-inspect-hotword-rule)) —
cloud API, 150+ infoTypes. Two ideas worth stealing: **likelihood buckets**
(`VERY_UNLIKELY … VERY_LIKELY` rather than raw floats — coarse bands make policy tables
legible and stable) and **inspection rules** — hotword rules that *adjust* likelihood based
on proximity context, and exclusion rules (dictionary / regex / reverse-hotword) that
suppress findings. This is confidence-adjustment as configuration rather than code.
**Verdict: reject (cloud-only — traces leave the machine); steal likelihood bands +
hotword/exclusion rules into the policy layer.**

**AWS Comprehend PII**
([docs](https://docs.aws.amazon.com/comprehend/latest/dg/how-pii.html)) — cloud ML
API, entity types with confidence scores, English/Spanish. No local mode. **Verdict:
reject (cloud-only). Nothing architecturally novel beyond Presidio/DLP.**

**scrubadub** ([docs](https://scrubadub.readthedocs.io/en/stable/),
[accuracy](https://scrubadub.readthedocs.io/en/stable/accuracy.html)) — Python, MIT/Apache
family. Detector/Filth/post-processor architecture; optional spaCy NER detector; ships an
accuracy harness. Its distinctive idea is the **known-filth detector**: seed the scrubber
with *specific known identifiers* (this person's name, this account number) and catch them
deterministically regardless of model performance. **Verdict: reject the runtime (Python;
regex-core recall is modest without spaCy); steal known-filth as the known-identity pack
(§6.4) — Jinn's daemon locally knows the operator's own identity surface (git
`user.name`/`user.email`, `gh` login, earning-state EOA/Safe/service addresses, home path)
and can hold recall ≈ 1.0 on self-PII with zero ML.**

**GLiNER family** ([repo](https://github.com/urchade/GLiNER), Apache-2.0;
[`urchade/gliner_multi_pii-v1`](https://huggingface.co/urchade/gliner_multi_pii-v1),
Apache-2.0; [ONNX port](https://huggingface.co/onnx-community/gliner_multi_pii-v1);
[knowledgator gliner-pii-{edge,small,base,large}](https://huggingface.co/knowledgator/gliner-pii-base-v1.0)) —
zero-shot span-based NER: a compact bidirectional encoder matches text spans against
**arbitrary label prompts at inference time**, so the entity schema is ours to declare
(person, wallet seed phrase, physical address, …) without retraining.
`gliner_multi_pii-v1` is PII-fine-tuned (40+ PII labels, 6 languages) with quantized ONNX
weights; JS inference paths exist ([`gliner` npm / GLiNER.js](https://socket.dev/npm/package/gliner),
MIT, v0.0.19; [`@lmoe/gliner-onnx`](https://www.npmjs.com/package/@lmoe/gliner-onnx);
onnxruntime-node), and `@huggingface/transformers` is already a core dependency. This is
what the 2026-06-15 spec specified before the implementation substituted bert-base-NER.
Risks: JS runtimes are young (0.0.x — pin and wrap behind the existing `PiiDetector` seam;
worst case, a thin custom ONNX session via onnxruntime-node, which the repo already ships
transitively); technical-text precision must be measured on our benchmark before T_auto is
set. **Verdict: adopt as the ML tier. Benchmark `gliner_multi_pii-v1` vs. the smaller
knowledgator edge/small variants on the operator-local corpus before pinning (§10 Q3).**

**piiranha-v1** ([model card](https://huggingface.co/iiiorg/piiranha-v1-detect-personal-information))
— mDeBERTa-v3-base fine-tune, 17 PII types, 6 languages; strong reported numbers (93.1%
multi-class F1, 98.3% token-level recall on its own test set). **License: CC BY-NC-ND 4.0 —
non-commercial, no-derivatives.** Jinn operators earn OLAS for the pipeline this scrub sits
in; that is commercial use, and no-derivatives blocks quantization/fine-tuning. **Verdict:
reject on license alone.** (Its fixed 17-label head is also less adaptable than GLiNER's
zero-shot labels.)

**bert-base-NER (incumbent ML stage)** — CoNLL-2003 newswire fine-tune, PER/ORG/LOC/MISC
only: no address/phone/ID classes, trained on 2003 news text, known to degrade on
technical prose. It was an implementation substitution, never the spec'd model. **Verdict:
retire when the GLiNER tier lands.**

### 5.2 Secrets scanners

**secretlint** ([repo](https://github.com/secretlint/secretlint)) — TypeScript, MIT,
maintained, pluggable rule packages; already the shipped pass-1. **Verdict: keep.**

**gitleaks** ([repo](https://github.com/gitleaks/gitleaks)) — Go, **MIT**, the
widest-coverage openly-licensed secret-rule corpus (per-rule regex + keyword pre-filter +
entropy threshold + per-rule allowlists in a single TOML). Runs fully offline. **Verdict:
adapt — vendor/port a pinned subset of its rule corpus into the deterministic tier as a
build-time-compiled TS pack** (the rules are data, not code; MIT permits it; the keyword
pre-filter idea also cuts scan cost). Optionally also run the binary as a CI gate over the
repo itself — different altitude, defense in depth.

**trufflehog** ([repo](https://github.com/trufflesecurity/trufflehog)) — Go, **AGPL-3.0**;
800+ detectors; its differentiator is **live verification**: it confirms a candidate secret
by calling the issuing provider's API. That transmits the secret off-machine — exactly what
this pipeline must never do (and for a scrubber, verification answers the wrong question:
we remove candidates, we don't confirm their potency). AGPL is also a bundling problem for
an MIT-published client. **Verdict: reject for the pipeline; acceptable as an
operator-optional local audit tool, never wired into publish.**

**openredaction** ([repo](https://github.com/sam247/openredaction),
[docs](https://openredaction.com/docs)) — TS, MIT, 558–570+ regex patterns with checksum
validation; the shipped strict-profile stage. Its own docs describe detection as
best-effort and recommend manual review for sensitive use. The pattern family that keeps
failing on technical prose (trigger word + bare `[A-Z0-9]{n,m}` tail — the #1372/#1391
mechanism) is a design property of the library's breadth-first document-domain approach,
not a bug to patch around: after 60+ denylisted patterns across four issues, a fresh test
found ~10 more within hours. Subtractive tuning of someone else's 570 patterns is strictly
worse than owning the ~15 deterministic shapes this threat model actually needs (§6.2), and
its case-insensitive whole-document placeholder substitution (the `license: MIT` →
`li[PLATE_2299]s` aggravator from #1391) corrupts content beyond the match site.
**Verdict: retire from the pipeline once the deterministic tier reaches shape parity
(§8, M3). The classes it uniquely covered that matter here (ETH addresses, checksummed
cards/IBANs) become owned first-class detectors.**

### 5.3 Evaluation tooling

**presidio-research / presidio-evaluator**
([evaluation docs](https://microsoft.github.io/presidio/evaluation/),
[repo](https://github.com/microsoft/presidio-research)) — per-entity precision/recall
evaluation, error analysis, and template-based synthetic data generation; recommends
**Fβ=2** (recall-weighted) as the headline metric for PII, which matches our asymmetry.
**Verdict: adopt the methodology (per-class metrics, Fβ=2, template-generated synthetic
fixtures for CI) — §7. The Python tooling itself is not a runtime dependency.**

### 5.4 Survey conclusions (per layer)

| Layer | Decision |
|---|---|
| Deterministic shapes + secrets | **Build/own** (~15 shape detectors incl. the ported #1959 address rule) + **keep** secretlint + **adapt** gitleaks rule corpus (MIT data) |
| Confidence + context model | **Adopt architecture** from Presidio (recognizer contract, context words, explainability) + DLP (likelihood bands, hotword/exclusion rules as config) |
| ML tier | **Adopt** GLiNER-family PII model, local ONNX, behind the existing `PiiDetector` seam; retire bert-base-NER |
| Known-identity pack | **Steal** scrubadub's known-filth concept; source identities from local state |
| Policy/disposition layer | **Build** (small; it is a table + an interpreter) |
| Eval harness | **Adopt methodology** from presidio-research; build the thin TS runner |
| Rejected outright | Google DLP, AWS Comprehend (cloud-only); trufflehog-in-pipeline (AGPL + secrets leave machine); piiranha (CC BY-NC-ND); openredaction (non-convergent precision on this content) |

## 6. Chosen architecture

### 6.1 Detector contract

Every detector — regex, checksum, entropy, carrier, ML — implements one contract and emits
**findings**, not edits:

```
Finding {
  class: ScrubClass          // §3.2 taxonomy (A1…E1), not library-native type names
  span: { key, start, end }  // attribute + offsets (ML tier included — offset-capable runtime required)
  confidence: Band           // VERY_LOW | LOW | MEDIUM | HIGH | VERY_HIGH  (DLP-style bands)
  evidence: string[]         // explainability: which shape/checksum/context/model fired (Presidio-style)
  detector: { name, version }
}
```

Scoring: deterministic shapes with checksum/carrier context enter at VERY_HIGH; shape-only
matches enter at MEDIUM and are **boosted** by context words within a window (assignment
keywords for A2: `token`, `secret`, `password`, `Authorization: Bearer`; carrier keywords
for B2) or **suppressed** by counter-evidence (instance allowlist hit; git-SHA shape;
env-var reference shape — `$NAME`/`${NAME}` in value position is a reference, not a
literal, per the measured §3.2 A2 hazard; inside a `jinn.*` structural attribute). Band
arithmetic is defined in one place; every adjustment is recorded in `evidence` so any
redaction is explainable after the fact.

Separating detection from disposition is the load-bearing structural change: it makes "one
scrub" possible (everyone runs all detectors), makes precision tunable per-detector
(no more per-lane subtraction), and makes every decision auditable.

### 6.2 Tier 1 — deterministic detectors (owned)

The ~15 shapes this threat model needs, owned in-repo (most already exist or are trivial):

- provider-prefixed secrets: secretlint pass-1 + the vendored gitleaks-derived pack (A1)
- email (B1 — shipped), home paths (D1 — shipped), AWS/GCP credential IDs (shipped, #1415)
- **ETH address**: `0x`+40-hex, EIP-55-aware, instance-allowlist-gated (C1 — the #1959
  rule, generalized; bare 40-hex without `0x` is a git SHA and passes)
- **git-identity carriers** (B2): `Author:` / `Committer:` / `Co-Authored-By:` /
  `Signed-off-by:` / `git config user.*` line shapes → joint name+email redaction. This
  single detector closes most of the measured 0/4 name gap, deterministically — names in
  traces overwhelmingly arrive through these carriers, not free prose
- credential-in-URL (A3): userinfo and known credential query-param names
- **reject classes** (A4/A5): 64-hex in key context, BIP-39 mnemonic runs (wordlist +
  sequence length), env-block line-run shape
- checksummed instruments (B7): card (Luhn), IBAN (mod-97)
- IP addresses with range classification (D2): loopback/reserved pass, public auto-redact,
  private flag
- phone with libphonenumber-style validation (B5)
- **machine-identity keys** (D3 carrier): attempt-manifest `host`-type keys and other
  structured telemetry keys carrying device identity join the key-policy tier
  (drop/redact at the key level — the measured hostname leak's carrier is a key, not
  prose; free-text hostname detection stays flag-only per §3.2)
- entropy fallback (A2): the shipped, heavily-tuned secretlint pass-2 gate carries forward
  as-is — its #1348/#1391 carve-outs are exactly the kind of owned, tested precision work
  this design keeps — but emits banded findings instead of edits

### 6.3 Tier 2 — ML detector (always on for publish)

GLiNER-family PII model, local ONNX, behind the existing `PiiDetector` seam. Covers B3
(free-prose names), B6, D3, E1 — the classes with no reliable shape. Zero-shot labels are
pinned in config (and hashed into the policy hash) so the entity schema is explicit.
Changes from today: **on by default for every publish lane** (the current
`captures.piiDetection.enabled: false` default means the designed name tier simply never
runs), fail-closed posture unchanged (model unavailable → publish aborts; the shipped
`MlPiiUnavailableError` altitude is correct), and the detector must surface offsets and
scores (both JS runtimes do; the current word-matching fallback in `ml-pii-stage.ts` is
replaced by span offsets).

Model-load cost is a publish-time cost, not a hot-path cost, same argument as the
2026-06-15 spec. The autopilot lane batches.

### 6.4 Known-identity pack and instance allowlist (two sides of one mechanism)

Both are locally-maintained instance lists with provenance, applied as confidence
overrides:

- **Known-identity pack (redact-list)**: at daemon start, assemble the operator's own
  identity surface from local state — git `user.name` / `user.email`, `gh` login, home-dir
  username, local hostname (`os.hostname()`), earning-state addresses (EOA, Safe, mech,
  service), configured emails. Exact (normalized) matches redact at VERY_HIGH regardless
  of ML availability. Recall ≈ 1.0 on self-PII, zero inference cost, works in every lane.
  (scrubadub's known-filth, pointed at the identity Jinn already holds locally.) The
  2026-07-22 mining inventory measures the gap this closes: operator handles appear 1–32
  times per autopilot home, machine-uncaught by both shipped profiles, across all 10 mined
  homes.
- **Instance allowlist (pass-list)**: verifiably-public values — the protocol address book
  (JinnRouter, OLAS token, staking contracts, mech marketplace — sourced from the repo's
  own `contracts.ts` constants, not hand-typed), loopback/reserved IPs, the repo's own
  slug. Each entry carries a provenance note. Allowlist hits suppress C1/D2 findings and
  are recorded in the manifest (an auditable "we saw it and passed it on purpose", which is
  more Legible than silence).

Third-party identities deliberately get **no** list: they are covered by carriers (B2),
the ML tier (B3), and review — a third-party list would itself be a PII store.

### 6.5 Policy layer — dispositions, one table

One versioned artifact (checked in, hashed, published in the manifest):

```
disposition(class, band) -> redact | reject-publish | flag | pass
```

Defaults follow §3.2's rightmost columns. The three current profiles collapse to:

- **redact-mode consumers** (trace publish, capture publish): apply the table.
- **check-mode consumers** (distillation layer-2, episode-lane refuse-and-fix): same table,
  with `redact|reject|flag` all mapped to **reject** — one mapping line, not a second
  pipeline. (The layer-2 "a false positive costs one re-distill" property is preserved:
  check-mode is strictly more conservative.)
- destination-specific threshold overrides, if any ever prove necessary, are explicit
  policy-table rows with rationale — reviewable in one diff.

Flag handling: in interactive lanes, `flag` routes to the review queue (§6.6). In
unattended lanes (autopilot), an unresolved flag **fails closed**: the item is held
unpublished until a human resolves the queue. Nothing auto-publishes over an open flag.

### 6.6 Review queue

The minimal surface that makes `flag` a real disposition: a local queue of flagged spans
with context (the finding, its evidence, surrounding text), resolved by
approve-instance / redact-instance / add-to-allowlist / add-to-identity-pack decisions.
First implementation is a CLI (`jinn scrub review`); a curation-SPA panel can follow
(§10 Q2). Every resolution is persisted operator-locally and exported as a labeled example
into the benchmark corpus (§7) — review effort compounds into measured recall, which is
what eventually licenses removing review per class (§3.3).

### 6.7 Failure posture and provenance

- **Fail closed, unchanged**: any stage error, model-load failure, reject-class finding, or
  unresolved flag in an unattended lane → the publish does not happen. The shipped
  publish-altitude posture (`CaptureScrubError`, `MlPiiUnavailableError`) carries forward.
- **Provenance upgrade**: the redaction manifest additionally records the **policy hash**
  (policy table + detector inventory + model ID + label set + allowlist digest) and
  **per-class redaction counts**. A fetched envelope then attests which scrub ran —
  closing the documented gap ("`TraceEnvelopeV0` does not publish that list") and turning
  the scrub from a private promise into a Legible, verifiable claim. Envelope schema
  change → sequenced in §8 (M4) and flagged in §10 Q5.

## 7. Evaluation harness — the acceptance gate

Two-tier, mirroring the constraint that real traces never leave the machine:

1. **Public synthetic tier (CI)**: template-generated fixtures per class
   (presidio-evaluator methodology — templates + fakers, no real PII), plus the existing
   seeded-secrets fixture and the four strict-defaced-but-clean curated seeds from the
   #1784 repro as the **corruption corpus**. Runs on every PR touching scrub. Gates:
   per-class recall on synthetic ≥ targets; **corruption rate = 0** on the clean corpus
   (byte-identical pass-through — this permanently locks the #1784 class of regression);
   git-SHA/protocol-address survival pinned.
2. **Operator-local real tier (release gate)**: `jinn scrub bench` runs the pipeline over
   the labeled operator-local corpus (seeded from the 2026-07-21 findings inventory and
   the 2026-07-22 mining inventory over 10 autopilot homes; grown by subsequent mining
   batches — which follow the same operator-local `mining-batch<N>-pii-inventory.md`
   counts-only convention per the batch-mining method doc — by autopilot trajectories,
   and by every review-queue decision). Emits a **metrics-only JSON** (per-class
   TP/FP/FN counts, recall, precision, Fβ=2 — no text, no spans) that is safe to publish
   and is attached to release readiness. The labeled data itself never leaves the machine.

   **Weighting caveat (measured 2026-07-22):** in autopilot homes a large share of raw
   hits comes from per-message *replayed context* — the CLAUDE.md injection carries the
   protocol contract addresses and repo paths into every message — not from distinct
   trajectory PII. The benchmark labels distinct leak **sources** and dedupes
   replayed-context repeats, so per-class metrics measure coverage of the leak surface
   rather than the replay frequency of one injected document. (The same measurement is
   direct evidence for the §6.4 instance allowlist: every wallet-shaped hit in those homes
   was a known protocol address.)

Headline metric per class: **Fβ=2** (recall-weighted — a miss is worse than a flag), plus
the corruption rate as the precision backstop (defacement is measured on content that must
survive, which is the failure #1784 actually describes — ordinary FP counts under-weight
it). Class targets are §3.2's table. Shadow mode (§8 M1) uses the same harness to diff the
new pipeline against the shipped one on identical inputs before any cutover.

The harness is also the **automation license** (§3.3): a class's disposition tightens
(flag → auto) only on sustained measured performance, and loosens immediately on a missed
gate. That is Governance Minimal applied to the scrub: mechanism, not standing judgment.

## 8. Migration and sequencing

### 8.1 The tactical coupled fix lands now — recommendation

**Land #1959 (+ the #1784 residuals) immediately as an interim, do not wait for this
redesign.** Reasoning:

- #1959 is a live, active leak on the lane that is publishing during Stage 2 curation;
  wallet addresses are permanent-linkage PII on an irreversible substrate. Highest open
  severity; zero reason to couple it to a multi-week redesign.
- The fix is a deterministic, zero-false-positive-risk rule (`0x`+40-hex with the
  strict profile's placeholder parity), and it is **not throwaway**: it is verbatim the
  §6.2 C1 detector minus the allowlist refinement. The redesign subsumes it without
  rework.
- #1784's remaining acceptance criteria (regression test pinning the seed-clean corpus;
  live publish of the D1 fixture) are similarly forward-compatible: the regression corpus
  *is* §7's corruption corpus, first edition.
- Sequencing note per #1959's own analysis: the address rule must land **with or before**
  any further reliance on the seed profile — the episode lane already runs the seed
  profile on `next` (PR #1856), so the leak window is open until #1959 merges.

One interim caution: the #1959 AC as written (redact all `0x`+40-hex) will also redact
known protocol addresses. Acceptable for the interim on the seed lane (small defacement,
zero leak); the §6.4 allowlist restores them at M2. The 2026-07-22 mining inventory
raises the stakes for the *autopilot* lane specifically: the CLAUDE.md injection replays
the protocol addresses into every message, so the interim rule would deface every
trajectory's replayed context there — the M2 instance allowlist is on the critical path
for autopilot capture, alongside M3's name coverage.

### 8.2 Redesign milestones

- **M0 — benchmark first.** Stand up the eval harness (§7) over the current pipeline and
  record the baseline. No detector work before the measurement exists; every subsequent
  milestone must move a number.
- **M1 — detector contract + shadow mode.** Introduce the finding/disposition split
  (§6.1) and the policy table (§6.5); port the existing stages (key-policy, plain-patterns,
  secretlint both passes) onto it emitting findings. Run the new pipeline in shadow beside
  the shipped one on real publishes, diffing via the harness. No behavior change yet.
- **M2 — deterministic-tier completion.** Git-identity carriers, ETH+allowlist,
  known-identity pack, reject classes, URL credentials, checksummed instruments, IP
  classification, gitleaks-derived pack. Cut over the redact-mode lanes;
  `buildSeedScrubPipeline` / `buildLayer2ScrubPipeline` become policy presets over the one
  pipeline (public API preserved, then deprecated).
- **M3 — ML tier + review queue.** GLiNER detector behind the `PiiDetector` seam
  (model choice per §10 Q3, benchmarked on the local corpus), on by default for publish;
  `jinn scrub review` CLI; retire bert-base-NER and openredaction (the denylists retire
  with it — delete, don't migrate). The autopilot capture lane's ~30 queued trajectories
  publish only after M3's measured B2/B3 recall clears targets — this is the gate that
  makes automated capture safe, and it is the schedule driver for M3.
- **M4 — provenance.** Policy hash + per-class counts into the redaction manifest
  (envelope schema rev; §10 Q5).

Each milestone is independently shippable and harness-gated; M2 alone already converts
every measured leak class (wallets, carrier names, self-identity) to deterministic
coverage.

## 9. Follow-up issues (problems, not solutions — handbook rule 2)

To be filed referencing this spec; acceptance criteria in the issues themselves:

1. `test` — Scrub has no measured recall/precision; build the two-tier eval harness and
   record the current baseline (M0).
2. `refactor` — Scrub detectors are selected per lane, not governed per class; introduce
   the finding/disposition architecture and collapse the three profiles onto one pipeline
   + policy table (M1–M2).
3. `feat` — Personal names in git-identity carrier lines survive the scrub next to their
   redacted emails; deterministic carrier detection (M2).
4. `feat` — Operator self-identity (git identity, home username, earning-state addresses)
   is known locally but not used by the scrub; known-identity pack + instance allowlist
   (M2).
5. `feat` — Catastrophic content (private keys, mnemonics, env dumps) is redacted instead
   of aborting the publish; reject-class handling (M2).
6. `feat` — Free-prose personal names have 0/4 machine recall; wire the ML PII tier on by
   default with a PII-tuned local model, and add the flag/review disposition surface
   (M3).
7. `feat` — A fetched envelope cannot prove which scrub ran; publish policy hash +
   per-class counts in the redaction manifest (M4).

(#1959 and #1784 already exist and cover the §8.1 interim; no new issue.)

## 10. Open questions for the operator

1. **Transaction hashes and operator-own addresses (C2/C1 policy).** Default proposed:
   protocol addresses allowlisted-pass, all other addresses redact (including
   operator-own), tx hashes flag. But the anchor tx already links the operator's service
   identity on-chain, and Legibility favors receipts — should operator-own addresses and
   tx hashes pass instead? (Affects §6.4 defaults only; mechanism unchanged.)
2. **Review surface placement**: `jinn scrub review` CLI first (proposed), or straight to
   a curation-SPA panel? (Affects M3 scope.)
3. **ML model pin**: `gliner_multi_pii-v1` (proven, multilingual, larger) vs.
   `knowledgator/gliner-pii-edge-v1.0` (smaller/faster, newer, less field history) —
   proposal: benchmark both on the local corpus at M3 entry and pin by measured Fβ=2 +
   latency; needs a one-word confirmation that a model-download-on-first-run posture
   remains acceptable (it is today's posture for bert-base-NER).
4. **Check-mode semantics confirmation**: distillation/layer-2 maps all non-pass to
   reject (§6.5) — confirm no distillation consumer needs redact-and-continue.
5. **Envelope schema rev** for the M4 provenance fields — fold into the next planned
   envelope version or ship as its own rev?
6. **Gitleaks rule-pack vendoring cadence**: pin-and-manually-refresh (proposed) vs.
   build-time sync tooling.

## 11. References

- Code: `packages/core/src/scrub/` (`build.ts`, `pipeline.ts`, `openredaction-stage.ts`,
  `plain-patterns-stage.ts`, `secretlint-stage.ts`, `ml-pii-stage.ts`,
  `transformers-detector.ts`, `pii-build.ts`, `layer2.ts`, `key-policy.ts`,
  `emit-scrub.ts`); `packages/layer/src/seed-import/episode-execute.ts`;
  `packages/layer/src/capture.ts`; `client/src/captures/publish.ts`
- Prior design: `spec/2026-06-15-ts-trajectory-scrub-stack.md`; DR-2026-07-06 decision 3
  (layer-2 check-mode); seed profile rationale in #1409
- Issue lineage: #1330, #1331, #1348, #1372, #1391, #1409, #1415, #1784, #1826 (curated
  batch gate), #1856 (episode-lane profile switch), #1959
- Survey: [Presidio analyzer](https://microsoft.github.io/presidio/analyzer/) ·
  [Presidio context enhancement](https://microsoft.github.io/presidio/tutorial/06_context/) ·
  [Presidio evaluation / presidio-research](https://microsoft.github.io/presidio/evaluation/) ·
  [Google DLP likelihood](https://cloud.google.com/dlp/docs/creating-custom-infotypes-likelihood) ·
  [Google DLP hotword rules](https://cloud.google.com/dlp/docs/samples/dlp-inspect-hotword-rule) ·
  [AWS Comprehend PII](https://docs.aws.amazon.com/comprehend/latest/dg/how-pii.html) ·
  [scrubadub](https://scrubadub.readthedocs.io/en/stable/) ·
  [GLiNER](https://github.com/urchade/GLiNER) ·
  [gliner_multi_pii-v1](https://huggingface.co/urchade/gliner_multi_pii-v1) ·
  [onnx-community/gliner_multi_pii-v1](https://huggingface.co/onnx-community/gliner_multi_pii-v1) ·
  [knowledgator gliner-pii family](https://huggingface.co/knowledgator/gliner-pii-base-v1.0) ·
  [GLiNER.js (npm `gliner`)](https://www.npmjs.com/package/gliner) ·
  [piiranha-v1 (CC BY-NC-ND)](https://huggingface.co/iiiorg/piiranha-v1-detect-personal-information) ·
  [secretlint](https://github.com/secretlint/secretlint) ·
  [gitleaks (MIT)](https://github.com/gitleaks/gitleaks) ·
  [trufflehog (AGPL-3.0)](https://github.com/trufflesecurity/trufflehog) ·
  [openredaction](https://github.com/sam247/openredaction) ·
  [openredaction docs](https://openredaction.com/docs)
