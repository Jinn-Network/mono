# Jinn Plugin Onboarding — Stage 2 Design (Session A)

- **Version:** 0.1
- **Date:** 2026-07-17
- **Author:** Ritsu (design session, Claude Fable 5)
- **Shape:** `design` — output is this spec; implementation lands as Stage 2 issues filed by the
  meta session
- **Brief:** `docs/superpowers/briefs/2026-07-17-session-a-onboarding.md`, under
  `docs/superpowers/briefs/2026-07-17-stage2-framing-packet.md` (working assumptions W1–W4 apply)
- **Ground truth:** issue #1654 walkthrough comments (2026-07-16/17) plus a four-agent code
  investigation on `next @ 6609b3e37` (summarized in §2)

## 1. Mission and gate

Design the complete-but-minimal onboarding for Jinn Plugin users: a person with a working Hermes
install gets from "never heard of Jinn" to their first visible `◇ corpus` moment with the
smallest possible surface area.

The acceptance gate, superseding the brief's "one install command per ecosystem" with
justification (§3.1 — the host's own plugin manager plus a self-contained plugin artifact makes
the stronger form reachable):

> Fresh machine with Hermes installed → first evidence packet visibly provided in a real session
> in **under 5 minutes**, with **one install command, total**, **zero consent questions** (W1),
> and a **self-verifying** setup — a doctor names every broken precondition and prints the one
> command that fixes it.

## 2. Empirical basis

The brief's four manual-intervention gaps (stale canary #1797; layer discovery by hand-made
symlink; wheel not on PyPI; nothing self-verifies) were confirmed against code. Investigation
added five findings that reshape the design:

1. **The documented install sequence never worked on the locked P2 target.** On stock upstream
   Hermes with a pip-only install, `hermes plugins enable jinn` fails ("not installed or
   bundled"): the enable CLI discovers plugins by directory scan only
   (`hermes_cli/plugins_cmd.py` → `_discover_all_plugins`), while entry-point scanning lives
   only in the runtime loader. The cold-stock gate masks this by hand-writing `config.yaml`.
2. **Stock Hermes ships a git-based plugin installer.** `hermes plugins install
   <owner>/<repo>[/<subdir>]` (verified present in upstream `NousResearch/hermes-agent` at the
   cold-stock pinned SHA `9df5f879`) clones into `~/.hermes/plugins/<name>`, prompts "Enable
   now?", and writes `plugins.enabled` itself — dissolving finding 1 for this path.
   `hermes plugins update|remove` provide update (git pull) and uninstall. The installed
   directory retains `.git`, giving build identity for free.
3. **The onboarding wizard is already hollow.** It is reachable only as an undocumented
   subcommand (no auto-trigger; Hermes has no first-run hook), blocks the terminal on `input()`,
   its consent step is exactly what W1 empties, and its "publish" step renders a hard-coded
   simulation — the real event was never wired (`onboarding.py:536-547`). The one
   production-shared piece is the `◇ corpus` line renderer, which `pickup.py` imports from
   `onboarding.py`.
4. **`/jinn status` is a state dump, not a doctor.** It performs no live checks, discards the
   layer's actionable remediation string (`__init__.py:88` drops stderr), memoizes a failed
   handshake for the whole process, and stays silent at session start on failure. The repo
   already contains the right pattern twice: the client CLI's `jinn doctor` emits
   `{name, ok, detail, remedy}` per check; `hermes doctor` covers model/provider sanity
   completely. Three unrelated "status/doctor" surfaces exist and do not compose.
5. **The empty state is half-built and the aha can misfire.** In-the-moment no-match behavior is
   silence (fail-open by design); an honest session-end line ("knowledge searched · nothing
   relevant found") already ships every session. The live corpus holds two evidence records, and
   the #1791 validation table documents a lexical collision ranking a distractor above the real
   source — the first impression can be a wrong packet, not just an absent one.

## 3. Design

### 3.1 Install story (one command, total)

```
hermes plugins install Jinn-Network/jinn-plugin      # clone → ~/.hermes/plugins/jinn → "Enable now? [y]"
```

That is the entire user-facing install. Mechanics:

- **`Jinn-Network/jinn-plugin` is a new slim repo** — the plugin directory published as its own
  repository, produced from mono by an automated split-and-push job that runs on the Monday
  `main` promote. The slim repo's default branch is therefore the release channel:
  `hermes plugins install` delivers the latest Monday cut, and `hermes plugins update jinn`
  (git pull) is the upgrade verb. Both artifacts a user needs ride this one channel.
- **The `jinn-layer` runtime arrives through the same single command.** *Resolved —
  DR-2026-07-17 Decision 3:* the plugin acquires the **published `@jinn-network/jinn-layer`**
  (Session C's C6); the plugin↔layer handshake spec (bin discovery, version pinning, the
  resolution order below) rides C6, and this track's final ratification waits for it. The
  constraint discovered here stands and binds C6: today's `dist/bin/jinn-layer.js` is
  esbuild-bundled with npm dependencies left external, so it only runs inside an npm install;
  the one-command story needs a layer artifact that works from the cloned plugin directory
  without a second ecosystem's install step appearing in the user path. Until C6 publishes,
  onboarding instructions stay dogfooder-grade (repo-based); the two-command
  `npm install -g` story does not ship as an interim.
- **Layer resolution order** becomes: the in-plugin-dir artifact (per the mechanism above) →
  `JINN_LAYER_BIN` → bare PATH — the last two demoted to dev/dogfood overrides. The remediation
  strings that today point at `@canary` are corrected as part of §3.5.
- **npm exits the user story.** `@jinn-network/client` remains the operator/daemon distribution
  with its existing canary/latest cadence; #1797 and #1754 stay load-bearing for that path and
  are not re-filed here.
- **Prerequisites** are honest and doctor-checked (§3.3): `git`, plus whatever runtime the
  chosen layer mechanism requires (Node ≥ 22 today) — the doctor names a missing prerequisite
  and prints the platform install hint rather than the README doing archaeology.
- **Dogfooders are unchanged**: fork checkout or mono repo-subdir installs keep working; the
  cold-stock gate keeps building from source.
- **Locked decision P2 is amended in letter, kept in spirit** — "stock upstream Hermes + the
  pip-installed plugin" becomes "stock upstream Hermes + the `hermes plugins install`ed plugin".
  The proof obligation ("keep your harness, add Jinn") is identical; the pip path is what
  finding 1 showed never worked. Ratified — DR-2026-07-17.

### 3.2 First run under W1 (no wizard, zero questions)

There is no onboarding flow. First run is a **one-time banner plus a loud-on-failure doctor**:

- **First session ever** (per install; a marker file replaces today's `onboarding.json` flags):
  a 2–3 line banner via the existing TUI-safe `_user_line` channel — the doctor's verdict
  (all green, or the first failure with its one fix command), one line of expectation-setting
  (what the `◇ corpus` moment looks like and that silence means no relevant prior evidence),
  and the `/jinn` pointer. Never blocks; never asks anything.
- **Every later session**: silent unless a session-start check fails, in which case the failure
  line (with remedy) prints once. A healthy install says nothing.
- The 3-step wizard is deleted (§3.5). Under W1 the consent step has nothing to gate and the
  publish step has nothing behind it; the signals step's job is absorbed by the banner.

### 3.3 The doctor

**Invocation:** `/jinn doctor` in-session; the same checks run automatically at session start
(fast subset) and populate the first-session banner (full set). A terminal entry point rides the
plugin's CLI-command registration (the mechanism today's wizard uses), so the doctor is reachable
without a TUI session; exact verb naming is settled at implementation. Placement of each check
(plugin vs. layer vs. host) is the A↔C seam: this spec fixes the checks and the output contract;
Session C decides where they live.

**Output contract** (adopting the client CLI's existing shape): per check
`{name, ok, detail, remedy}` — `remedy` is exactly one copy-paste command, present on every
failure. Human rendering: `[ok]`/`[fail]` lines, indented remedy, one-line summary. The doctor
is **print-only**: it never executes fixes.

**Checks:**

| name | verifies | knowledge owner | remedy on failure | runs |
|---|---|---|---|---|
| `plugin-build` | installed plugin identity: git SHA of `~/.hermes/plugins/jinn`, dirty flag | plugin | `hermes plugins update jinn` | session start + full |
| `layer-available` | the layer artifact resolves and executes (mechanism per §3.1; env/PATH overrides reported when active) | plugin | mechanism-dependent (e.g. `hermes plugins update jinn`); dev override hint | session start + full |
| `layer-contract` | `contract --json` returns v1 | plugin↔layer seam | `hermes plugins update jinn` | session start + full |
| `prerequisites` | required runtime present (Node ≥ 22 under today's mechanism) | plugin | platform install hint | session start + full |
| `corpus-reachable` | one layer round-trip to the corpus/indexer | layer | network/config guidance; explicitly non-blocking — retrieval degrades to nothing-found and work proceeds (product design §4.6) | full only |
| `corpus-content` | corpus has retrieval-visible content matching this repo (repo-slug query — the signal pickup already sends) | layer, fed by plugin | none — **informational**, expectation-setting: "no matching content yet; Jinn stays quiet until it exists" | full only |
| `host-provider` | — not a Jinn check. The doctor points at `hermes doctor`, which owns provider/credential sanity completely | host | `hermes doctor` | full only (pointer line) |

**Repairs folded in** (shipped defects the doctor design subsumes): stop discarding the layer's
remediation stderr; drop the process-lifetime memoization of a failed handshake (re-check on
every doctor run and at each session start); session-start failure prints instead of staying
silent.

### 3.4 First-session aha and the designed empty state

- **The provided moment is unchanged** — the `◇ corpus  provided N evidence packet(s) · searched: …`
  line, proven live in walkthrough #4.
- **Empty state, in the moment, exactly once:** the first session ever renders the honest
  variant — `◇ corpus  searched N terms · nothing relevant yet` — so the user sees the mechanism
  exists. Every later no-match session is silent in the moment; the existing session-end
  "knowledge searched · nothing relevant found" line continues every session; `/jinn session`
  remains the on-demand view.
- **What A requires of B (seams register):** before onboarding points at any named early user,
  retrieval-visible curated content exists for that user's repos ("enough corpus" is B's to
  define, but the doctor's `corpus-content` check must be able to query it), and B owns the
  relevance bar — the documented distractor-first collision means a wrong first packet is worse
  than an empty first session.

### 3.5 Deletions (surface reduction)

| Deleted | Note |
|---|---|
| `onboarding.py` 3-step wizard, its CLI subcommand, `onboarding.json` flag machinery | `render_evidence_signal_line` moves to a view module (production `pickup.py` imports it); banner marker replaces the flags |
| `render_skipped_all` | already orphaned — zero call sites |
| `/jinn consent`, `/jinn preview`, session-start consent hint, `sharing:`/`share:`/`previewed:` status lines, consent wizard step | W1: nothing to gate. `/jinn status` gains one line: `contribution: parked — nothing leaves this machine` |
| `/jinn ledger` | an empty-forever receipt is a dead surface; the parked line plus docs carry the privacy promise until the outbound lane returns with its own design |
| `skills_install.py` | dead since the rescope — zero callers |
| `jinn_layer.publish()` wrapper | zero callers (mint lane is `session end`-only) |
| `@canary` remediation strings | corrected per §3.1 |
| plugin.yaml `hooks:` key | inert (parser reads `provides_hooks`); fixed as hygiene |
| README staleness | removed `skills install` copy; install story per §3.1; state-purge documented (state spans `$HERMES_HOME/jinn/` **and** `~/.jinn-client/` — today undocumented) |

Retained: pickup and the `◇` moment, session-end summary, `/jinn status` (slimmed: build,
bridge, capture, distill, parked line), `/jinn session`, `/jinn history`, `/corpus` + the two
agent tools, distill surfaces. Local capture, candidate recording, and distillation remain
unconditional per W1. Pending-trace files are retained as private data; their status line goes.

A's requirement on the parked state (to C): outbound publication is **structurally off,
fail-closed** — not merely defaulted off; how much backing code is deleted vs. quarantined is
C's architecture call.

### 3.6 Acceptance gate (four layers)

1. **Extended cold-stock (CI, per PR):** exercise the real journey — `hermes plugins install`
   from a local `file://` clone source, the real enable prompt path, doctor green on a correct
   install, then a break-each-precondition matrix (layer artifact absent; contract-version stub
   mismatched; corpus endpoint down; plugin dir dirty/stale) asserting the doctor names each
   failure and prints the right remedy, then `hermes plugins remove` and the stock-silence
   assertion via the real CLI (closing today's hand-written-config bypass).
2. **Published-artifacts smoke (scheduled + post-release):** on a clean runner, install the slim
   repo exactly as a user would, run the full doctor, and drive one live pickup against the real
   corpus. This is the only layer that catches the #1797 class — breakage that exists only in
   published artifacts, structurally invisible to repo-internal CI. Alerts through the existing
   webhook pattern.
3. **Agent-driven rehearsal:** before operator ratification, the coordinating agent runs the
   full onboarding in a terminal on a clean environment exactly as the user would type it, and
   attaches the transcript to the tracking issue — the walkthrough discipline (nine Stage 1
   defects were CI-invisible) applied ahead of operator time.
4. **Operator ratification:** the operator runs the designed onboarding on a fresh environment
   and reaches the `◇` moment inside the 5-minute budget. This is the acceptance moment.

### 3.7 Non-goals

- Multi-host onboarding (Claude Code / Codex adapters) — Stage 3+.
- Accounts, sign-in, or server-side user state — none.
- Telemetry — zero; nothing phones home beyond the corpus/indexer calls the product already
  makes.
- Doctor `--fix` execution — print-only this stage.
- PyPI distribution of the plugin for users — the pip package remains CI/dev plumbing only.
- Auto-update or update nagging — `plugins update` is manual; the doctor reports identity, not
  advertisements.
- Any dependency on upstream Hermes changes — the design works on stock Hermes as shipped at the
  pinned SHA.
- npm anywhere in the user install path.

## 4. Working-assumption flags (where this design changes if one flips)

- **W1 flips (outbound contribution returns):** first-run stays zero-question by default; a
  consent moment returns as part of that era's own lane design, not by resurrecting the deleted
  wizard. The parked status line and the ledger's absence are the two surfaces that change.
  Deletion now is still correct — rebuilding a designed consent moment later is cheaper than
  maintaining dead surfaces meanwhile.
- **W2 flips (single-tier corpus):** `corpus-content` loses its tier filter; otherwise
  unaffected.
- **W3 flips (growth from contribution, not seeding):** the A↔B guarantee softens from "curated
  content exists for named repos" to a coverage expectation; the empty state is unchanged.
- **W4 flips (model calls in retrieval):** no structural impact on onboarding; the
  `corpus-content` query mechanics may change under C/B's retrieval work.

## 5. Proposed issues (not filed — meta session reconciles)

| # | Title | Shape | Packages | Depends on | Effort |
|---|---|---|---|---|---|
| A1 | Layer acquisition — **resolved, DR-2026-07-17 Decision 3**: folds into C6 as the plugin↔layer handshake spec; not filed separately | design | — | — | — |
| A2 | Slim-repo release channel: `Jinn-Network/jinn-plugin` + split-and-push job on `main` promote | chore | `.github/workflows`, `apps/jinn-agent/plugins/jinn` | A1 (layer artifact inclusion) | Medium |
| A3 | Doctor: checks, output contract, session-start loudness, first-session banner | feat | `apps/jinn-agent/plugins/jinn` | — (layer-available check is mechanism-agnostic) | High |
| A4 | Delete wizard + consent surfaces; relocate `◇` renderer; parked status line | refactor | `apps/jinn-agent/plugins/jinn` | — | Medium |
| A5 | Layer-side probes: corpus reachability + content-present query | feat | `client/packages/harness-layer` (or per C placement) | C placement decision | Medium |
| A6 | Cold-stock extension: real install/enable path, doctor precondition matrix, real remove | test | `apps/jinn-agent/scripts` | A3, A4 | Medium |
| A7 | Published-artifacts smoke workflow (scheduled) | chore | `.github/workflows` | A2 | Medium |
| A8 | Cross-language contract-constant parity test (Python literal == TS literal) | test | `apps/jinn-agent`, `packages/plugin` | — | Low |
| A9 | Docs: README install story, state-purge documentation, product-design §4.1/§4.8 amendment pointers | docs | `apps/jinn-agent/plugins/jinn`, `docs/` | A2 | Low |

Merge-pairing note for the meta session: A3 and A4 converge on `__init__.py` and should land as
one paired train (the rescope's convergent-file discipline); A6 follows them.

## 6. Seams & assumptions register

**Assumes from other tracks**

- From **B**: curated retrieval-visible content exists for a named early user's repos before
  onboarding targets them; B defines "enough corpus" in a form the `corpus-content` check can
  query; B owns the relevance quality bar (wrong-first is worse than empty — #1791's documented
  collision).
- From **C**: the layer-acquisition mechanism for the one-command install (resolved —
  DR-2026-07-17 Decision 3: the C6-published layer; §3.1's constraint binds C6); process contract v1 stability
  through the package extraction, or a versioned migration the doctor can name; the plugin
  directory stays self-contained and movable (slim-repo split viability); placement of the
  doctor's layer-side checks (A fixes the checks and contract, C places them); the
  structurally-off, fail-closed implementation of parked outbound.

**Provides to other tracks**

- The doctor check list and `{name, ok, detail, remedy}` output contract (C consumes for
  placement; B's `corpus-content` semantics ride it).
- The one-command install UX and the slim-repo Monday release channel (meta files A2).
- The deletion inventory (§3.5) as input to C's migration planning.
- The banner and empty-state moments as content targets for B's seeding.
- The four-layer gate pattern, including agent-driven rehearsal before operator ratification.

**Would renegotiate**

- **P2's letter**: "pip-installed plugin" → "`hermes plugins install`ed plugin" (spirit intact;
  the pip path never worked on the target — §2 finding 1). Ratified — DR-2026-07-17.
- **The brief's gate**: "one install command per ecosystem" → "one install command, total".
  Ratified — DR-2026-07-17.
- Nothing on W1–W4 — all four hold; W1 makes onboarding strictly simpler.

## 7. Verification moment

Per the brief: the acceptance of this design is the operator running the designed onboarding on
a clean environment — fresh machine or pristine VM with only Hermes and the stated prerequisites
— reaching the first visible `◇ corpus` moment inside the 5-minute budget, with the agent-driven
rehearsal (§3.6 L3) run and its transcript attached beforehand.
