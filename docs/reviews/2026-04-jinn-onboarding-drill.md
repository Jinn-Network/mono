# Jinn operator onboarding drill — Base Sepolia

**Date:** 2026-04-17
**Reviewer:** Claude (operator drill, npx install, Base Sepolia)
**Target surface:** `@jinn-network/client@latest` (0.1.0 on npm) and the current worktree `main`/`ale/jinn-operator-onboarding-drill`
**Working dir:** `/tmp/jinn-onboarding-drill` (fresh, clean `$HOME`)

## How this drill was run

Simulated a brand-new operator following `client/README.md`. All invocations
used `npx --yes -p @jinn-network/client@latest jinn <verb>` against a fresh
`$HOME=/tmp/jinn-onboarding-drill/home`. Transcripts are preserved under
`/tmp/jinn-onboarding-drill/logs/*.log` on the drill host. No contracts were
funded; every command was exercised as far as the unfunded path allowed, plus
behavioural probes (help, `--human`, dry runs, state introspection).

After the first pass against the published tarball, every finding was
re-verified against the current worktree HEAD by running `yarn build` and
invoking `node dist/bin/jinn.js ...` out of a fresh `$HOME` under
`/tmp/jinn-head-drill/`. The second column in the table below reflects that
HEAD build. The per-finding sections below call out "Status on HEAD:" at
the top of each entry.

## Summary

| Severity | Count (published 0.1.0) | Still reproducible on HEAD |
|---------|------------------------|----------------------------|
| Blocker | 3 | 2 |
| Major   | 6 | 4 (+2 partially fixed) |
| Minor   | 5 | 4 (+1 partially fixed) |
| Nit     | 4 | 3 (+1 fixed) |

The headline issue on the published tarball — the three documented lifecycle
commands `jinn init` / `jinn fund-requirements` / `jinn bootstrap` disagreeing
about which master wallet exists — **is already fixed on HEAD** by the
hydration branch in `client/src/earning/bootstrap.ts:342-352` (commit
`e09fde0d`, 2026-04-16). Verified on HEAD: all three verbs now resolve to the
same master address. The fix is just not yet in any published release.

Everything else in the finding list is *still reproducible on HEAD* unless
noted otherwise in the per-finding "Status on HEAD" header. The README
quick-start contradiction, the `jinn logs` empty envelope, the `jinn doctor`
keystore-filename bug, the `jinn submit-intent --dry-run` `"0x"` placeholder,
and `jinn version`'s `commit: "unknown"` are all present on HEAD and need
follow-up fixes.

## Findings

### Blocker-1 — `jinn init` and `jinn bootstrap` generate different master wallets in published 0.1.0

**Status on HEAD: FIXED (unreleased).** Verified by running HEAD-built
`jinn init → fund-requirements → bootstrap` on a fresh `$HOME`; all three
resolved to the same master `0x2786794153C786D27d0D04302B8fBD7DD02C0966`
with no "Generating new HD wallet" stderr. Published 0.1.0 still broken.
The remaining gap on HEAD is that `jinn init` itself still does not write
`earning_state.json`; hydration works only because `bootstrap` now reads
the existing keystore when `state.master_address` is empty.

**Where:** `client/src/earning/bootstrap.ts:186-195` (published 0.1.0 dist)
vs `client/src/cli/commands/init.ts:62-70`, `client/src/earning/store.ts:15`.

**What I observed:**
1. `JINN_PASSWORD=... jinn init` → master `0x2034…a9` (writes
   `master_keystore.json`, does **not** write `earning_state.json`).
2. `JINN_PASSWORD=... jinn fund-requirements` → master `0xEd9f…92`
   (stderr: `[fleet-bootstrap] Generating new HD wallet...`, keystore
   overwritten, new `earning_state.json` created).
3. `JINN_PASSWORD=... jinn bootstrap` (on the same `$HOME`) →
   master `0x0869…94` (keystore overwritten yet again).

Every `fund-requirements` / `bootstrap` invocation calls `ensureMasterWallet`,
which in the published build takes the `generateMnemonic()` branch whenever
`earning_state.json` is missing *or* `state.master_address` is empty —
unconditionally overwriting any mnemonic `jinn init` left behind. The
operator's funded wallet from a previous session can therefore be destroyed
by a second run of `jinn bootstrap`.

**Proposed fix:**
* Short term: publish the HEAD hydration branch
  (`client/src/earning/bootstrap.ts:342-352`) as a patch release and cover it
  with a test that asserts `init` → `bootstrap` yields the same address.
* Long term: make `jinn init` write `earning_state.json` too so the state
  machine starts with a coherent record; or drop `jinn init` altogether and
  treat `jinn bootstrap --init-only` as canonical. The README quick start
  currently implies `init` is load-bearing, and it is not.

---

### Blocker-2 — README quick start contradicts `jinn init` runtime contract

**Status on HEAD: NOT FIXED.** `client/README.md:19-28` on HEAD still shows
`jinn init` on its own line without `JINN_PASSWORD`; `jinn init` on the
HEAD build still exits 11 `invalid_invocation` without the env var.

**Where:** `client/README.md:19-28` vs `client/src/cli/commands/init.ts:40-52`.

The quick start block is:

```
jinn init
jinn doctor
JINN_PASSWORD=your-keystore-password jinn run
```

`jinn init` without `JINN_PASSWORD` exits **11** with
`invalid_invocation` — verified on 0.1.0 (see
`/tmp/jinn-onboarding-drill/logs/16-init-no-pw-*.log`). A new operator
copy-pastes the README and gets the error as their first experience.

**Proposed fix:** update the README block to
`JINN_PASSWORD=... jinn init` (matching the `jinn init` helpText example in
`client/src/cli/commands/init.ts:105-107`) and add a one-line explanation
that the password encrypts the mnemonic and is required.

---

### Blocker-3 — `jinn submit-intent --dry-run` renders a plan with an empty `creatorMultisig`

**Status on HEAD: NOT FIXED.** HEAD build still emits
`"Would post intent 't' from 0x"` and `"creatorMultisig":"0x"` when no
service at step `complete` exists.

**Where:** `client/src/cli/commands/submit-intent.ts:73-80`.

When there is no service at step `complete`, the dry-run fallback is
literally the string `'0x'`. Output:

```json
{"dryRun":true,"description":"Would post intent 'health-check' from 0x",
 "plan":[{"id":"health-check","creatorMultisig":"0x","asset":"native","txCount":1}]}
```

This is a silent lie to the operator: the plan says "one tx, asset native"
but there is nobody to send from. It should short-circuit to a structured
`funding_required` / `bootstrap_required` envelope that tells the operator
to run `jinn bootstrap` first. As-is, a scripted caller would cache the
empty multisig in the intent cache key (`client/src/cli/commands/submit-intent.ts:11-13`
uses `getAddress(safe)`, which will actually throw on `'0x'` in a real call
— so the `--yes` path is a silent time-bomb).

**Proposed fix:** in `submit-intent.ts`, if no `service.step === 'complete'`
is found, emit an envelope with code `bootstrap_required` (or a funding
envelope if applicable) and exit non-zero, instead of rendering a placeholder
plan.

---

### Major-1 — `jinn doctor` keystore check targets the wrong filename

**Status on HEAD: NOT FIXED.** `client/src/cli/commands/doctor.ts:32` still
reads `join(earningDir, 'mnemonic.keystore.json')` while the store writes
`master_keystore.json`. Verified: after `jinn init` on HEAD, doctor still
prints `"no keystore yet (expected on a fresh install)"`.

**Where:** `client/src/cli/commands/doctor.ts:31-45` vs
`client/src/earning/store.ts:15`.

Doctor reads `join(earningDir, 'mnemonic.keystore.json')` but the real
keystore path is `master_keystore.json`. Consequence: after `jinn init`, the
`keystore_readable` check still reports `detail: "no keystore yet (expected
on a fresh install)"` — so the operator can never confirm from `doctor`
that `init` succeeded.

**Proposed fix:** reuse the constant / helper from `FleetStateStore` instead
of hard-coding the filename. Add a regression test that snaps doctor output
after `init`.

---

### Major-2 — `jinn logs` violates the output contract (empty stdout)

**Status on HEAD: NOT FIXED.** HEAD build of `jinn logs` on a fresh install
still writes 0 bytes to stdout, exit 0.

**Where:** `client/src/cli/commands/logs.ts:41-58`.

`jinn logs` on a fresh install writes **zero bytes to stdout** (exit 0,
verified `wc -c = 0` on drill log `15-logs-detail.log`). Per
`client/README.md:111-114` the output contract is "JSON by default" with a
structured envelope. Empty stdout breaks scripted consumers and gives no
signal to humans either.

**Proposed fix:** emit a minimal envelope even when empty, e.g.
`{"schemaVersion":1,"generatedAt":"…","events":[],"cursor":{"next":null}}`,
matching `jinn history`. `--human` should print a one-line "no events yet"
hint. Add a test for the empty case.

---

### Major-3 — `--human` is wired only for a subset of verbs; `version` and `doctor` ignore it

**Status on HEAD: NOT FIXED.** HEAD `jinn version --human` and
`jinn doctor --human` still emit JSON (pretty-printed). `fund-requirements
--human` still emits `5000000000000000 wei` rather than `0.005 ETH`.

**Where:** `client/src/cli/commands/version.ts`, `client/src/cli/commands/doctor.ts`.

README operator contract (`client/README.md:111-116`) says "Add `--human`
for readable terminal output". Observed today:
* `jinn version --human` → raw JSON with keys like `deployments.digest:
  "unknown"` and `tokens.bond.address`. No English-language description of
  the phase, chain, or addresses. (`logs/02-version.log`)
* `jinn doctor --human` → pretty-printed JSON only. No English remedy list.
  (`--human` invocation shown in drill transcript.)
* `jinn fund-requirements --human` *does* produce a human formatter
  (`client/src/cli/commands/fund-requirements.ts:27-41`) but it emits raw
  wei (`5000000000000000 wei, have 0 wei`) instead of ETH — hostile to the
  ops persona the flag is supposedly for.

**Proposed fix:** add human formatters for `version` (`"Jinn client 0.1.0
(phase-1b, testnet/base-sepolia). Commit: unknown."`) and `doctor`
(checklist-style with ✓ / ✗). Humanise the units in
`fund-requirements` using `formatUnits` with the resolved decimals / symbol
already present on the row.

---

### Major-4 — Operator quickstart never covers actually starting the fleet on Base Sepolia

**Status on HEAD: PARTIALLY FIXED.** HEAD now ships a `jinn quickstart`
verb (`client/src/cli/commands/quickstart.ts`, committed d2d5b9da) that
combines `init → fund → bootstrap → run` — the exact one-shot the README
quick-start is missing. `client/README.md` on HEAD, however, still does
not mention `jinn quickstart` at all; neither does the
"Operator commands" table. So the plumbing exists but is invisible to a
new operator reading the README.

**Where:** `client/README.md:17-28`, `client/README.md:40-70`,
`client/src/cli/commands/quickstart.ts`,
`docs/phase1a-operator-runbook.md:1-215`.

The README's "Quick start" goes `init` → `doctor` → `run`. But `run`
requires a bootstrapped, funded fleet; the block never mentions
`fund-requirements`, `bootstrap`, testnet faucets, or that the daemon pauses
at `awaiting_funding`. Meanwhile `docs/phase1a-operator-runbook.md` is
written for someone *deploying* the stack themselves — it demands
Sepolia/Base Sepolia private keys, contract deploys, artifacts under
`contracts/deployment-phase1a-*.json`, etc. — which is not what a Phase 1b
operator who `npm i -g`-es the package should need (deployments are bundled
under `client/deployments/`, verified present in the installed tarball).

Result: a new operator reaches the quick start, hits the funding gate, opens
the runbook, and is told to deploy contracts. There is no "npm operator"
path in either doc. This is the largest documentation gap.

**Proposed fix:** add a short "Full onboarding on Base Sepolia (published
client)" section to `client/README.md` that lists
`init → doctor → fund-requirements → fund via faucet → bootstrap →
run → submit-intent → status`, with a pointer to
`docs/phase1a-operator-runbook.md` only for operators who want to stand up
their own stack.

---

### Major-5 — `jinn version` hard-codes `"unknown"` for commit and deployment digest on the published tarball

**Status on HEAD: PARTIALLY FIXED.**
`client/scripts/write-dist-build-meta.mjs` now resolves the commit from
`JINN_BUILD_COMMIT` / `GITHUB_SHA` — so a CI publish will carry a real SHA
(local `yarn build` still reports `"unknown"`, verified on HEAD). The
`deployments` side is still broken: `computeDeploymentDigest`
(`client/src/cli/deployment-digest.ts:14-38`) only reads
`config.testnet*DeploymentPath`, which is populated only from
`JINN_TESTNET_*_DEPLOYMENT` env vars. The bundled deployments that
`getChainConfig` discovers via
`client/src/earning/contracts.ts:28-33` are not fed into the digest, so
`jinn version` on HEAD still reports `digest: "unknown"` and `artifacts:
[]` for a zero-config operator.

**Where:** drill transcript `logs/02-version.log`, build step in
`client/package.json:build` (`node scripts/write-dist-build-meta.mjs`),
`client/src/cli/deployment-digest.ts`,
`client/src/earning/contracts.ts:28-33`.

Published 0.1.0 reports:

```json
"client": {"version": "0.1.0", "commit": "unknown"},
"deployments": {"digest": "unknown", "artifacts": []},
```

The artifacts list is empty even though `client/deployments/` is bundled,
and `commit` is `"unknown"` even though the package was published from a
specific git SHA. Operators cannot correlate support questions with a code
revision.

**Proposed fix:** have `scripts/write-dist-build-meta.mjs` (or the prepublish
hook) populate `commit` from `git rev-parse HEAD`, and resolve the
deployments manifest into `artifacts` at publish time. Surface them in
`jinn version`.

---

### Major-6 — README lists commands that are not in the published CLI

**Status on HEAD: PARTIALLY FIXED.** HEAD `jinn --help` now enumerates
`quickstart`, `plugin`, and `update` alongside the original verbs
(verified: `node dist/bin/jinn.js --help` on HEAD). `client/README.md`
still does not list `quickstart`, `plugin`, or `update` in the
"Operator commands" table — the README / help mismatch has flipped
direction rather than closed.

**Where:** `client/README.md:97-107` vs `jinn --help` on 0.1.0
(`logs/01-help.log`) and HEAD help output.

The "Actions" table lists `jinn fleet scale --to N`, `jinn fleet retire <index>`,
and `jinn withdraw --to <addr>`. On 0.1.0, `jinn --help` advertises
`fleet scale --to N` and `fleet retire <index>` — fine — but *also* quietly
omits the newly added `quickstart`, `plugin install`, `update` verbs that
exist in the HEAD source (`client/src/cli/commands/{quickstart,plugin-install,update}.ts`).
The README similarly makes no mention of the Docker quickstart path shipping
its own onboarding wrapper. A new operator searching the README for the
command they see mentioned in commits (`jinn quickstart`) will not find it.

**Proposed fix:** regenerate the command table from the `Command` registry
at build time (e.g. a `scripts/generate-cli-reference.ts`) and include it in
the README and in `jinn --help`'s footer. At minimum, update the README
table to list *every* verb the published binary accepts.

---

### Minor-1 — `jinn init` output does not mention next steps or mnemonic safety

**Status on HEAD: NOT FIXED.** HEAD `jinn init` JSON payload is still
`{"master": …, "keystoreDir": …}` with no `nextStep` hint or backup warning.

**Where:** `client/src/cli/commands/init.ts:72-90`.

JSON result is `{"master": "0x…", "keystoreDir": "/…"}`. No hint to run
`jinn fund-requirements`, `jinn keys backup`, or warning that the password
cannot be recovered. A first-time operator has to read help for every
subsequent verb to discover the happy path.

**Proposed fix:** extend the payload with a `nextStep: { cli: "jinn
fund-requirements", purpose: "List addresses that need funding" }` (this
mirrors the envelope contract) and have the human formatter print a brief
backup warning.

---

### Minor-2 — `jinn doctor` reports `ok: true` for a missing keystore

**Status on HEAD: NOT FIXED.** Same behaviour as published — always
reports `ok: true` with `"no keystore yet (expected on a fresh install)"`,
compounded by the filename bug in Major-1.

**Where:** `client/src/cli/commands/doctor.ts:40-45`.

Because the file check uses the wrong filename (Major-1), the check can only
ever report `ok: true`. Even when the filename bug is fixed, conflating
"keystore absent" with "keystore valid" makes the `ok: true / blockingCount:
0` summary misleading. A cautious operator won't know from `doctor` alone
whether `run` will succeed.

**Proposed fix:** split the check into two — `keystore_present` (informational,
`ok` reflects existence) and `keystore_readable` (only runs if present;
attempts to decrypt with a provided password-fd, else reports `skipped`).

---

### Minor-3 — npm install spews deprecation warnings on every `npx` invocation

**Status on HEAD: NOT FIXED.** `client/package.json` on HEAD still pulls
the js-IPFS stack; the warnings reproduce the same way on any fresh
`npx @jinn-network/client@latest` run.

**Where:** client dependency tree (`ipfs-http-client`, `ipfs-core-utils`,
`ipfs-core-types`, `multicodec`, `multibase`, `cids`, `prebuild-install`).

Every documented command in the drill emitted 7 warnings as the first thing
the operator sees. This drowns the actual CLI output and makes the tool
feel abandoned.

**Proposed fix:** migrate from js-IPFS → Helia (the upstream replacement
called out in the warning) or drop the js-IPFS dependency entirely. If the
migration is large, at least prune the transitive `multicodec`/`multibase`/
`cids` pins with resolutions so the user-visible warning list drops to 2–3
lines.

---

### Minor-4 — `jinn keys backup` silently writes a plaintext mnemonic

**Status on HEAD: NOT FIXED.** HEAD `jinn keys backup` still writes the
12-word mnemonic in plaintext and emits only
`{"verb":"keys backup","output":"...","words":12}` with no warning.

**Where:** `client/src/cli/commands/keys-backup.ts` (file created at
`./backup.json` during drill; content was literal 12-word mnemonic with
mode 0600).

The JSON stdout only reports `{"output": "./backup.json", "words": 12}` —
there is no warning that the file contents are plaintext. The 0600 mode is
good, but the README entry (`client/README.md:107`) says
"Export mnemonic" with no caveat. An operator syncing `~/backup.json` to
Dropbox will not realise they have just uploaded their seed phrase.

**Proposed fix:** echo a stderr warning ("Mnemonic written in plaintext,
mode 0600. Treat `./backup.json` as seed material."), and/or support a
`--encrypt-with-password` flag that reuses `encryptMnemonic`.

---

### Minor-5 — `jinn bootstrap --help` shows a failure example but `jinn run` does not

**Status on HEAD: PARTIALLY FIXED.** HEAD `jinn run --help` now describes
the funding gate in prose ("exits 10 with a funding_required envelope if
funding is missing") but still does not include a concrete
copy-pasteable failure example like `bootstrap --help` does.

**Where:** `client/src/cli/commands/bootstrap.ts:helpText`,
`client/src/cli/commands/run.ts:helpText`.

`bootstrap --help` nicely shows the `funding_required` envelope. `run`
does not — but `run` is what the README tells the operator to invoke first.
If `run` fails with a funding gate, the help text should illustrate that
path the same way.

**Proposed fix:** mirror the failure-example block into `run` (and
`submit-intent`, which can also fail with funding/bootstrap gates).

---

### Nit-1 — `jinn` help omits `quickstart`, `plugin install`, `update` even when the binary ships them

**Status on HEAD: FIXED.** HEAD `jinn --help` now lists `quickstart`,
`plugin`, and `update` alongside the original verbs. Keep this finding
for the published-tarball history.

**Where:** `client/src/cli/help.ts` or wherever verbs are enumerated.

The help page lists curated verbs; the source tree has more. Either the help
text should enumerate everything (preferred — use the same command registry
the dispatcher uses) or out-of-band verbs should be marked "experimental"
so operators know they exist.

---

### Nit-2 — `version.tokens.bond.symbol` and `.reward.symbol` are both `stOLAS`, but README still references OLAS/JINN

**Status on HEAD: NOT FIXED.** `client/README.md` on HEAD still has no
`stOLAS` reference; `docs/phase1a-operator-runbook.md:263-268` still
talks about OLAS bonds.

**Where:** `version` output on 0.1.0 (`logs/02-version.log`) vs
`docs/phase1a-operator-runbook.md:263-268` and `CLAUDE.md:80-86`.

The operator reads that the bond is "OLAS, 2× bond amount" and sees the
client say "stOLAS 0xAB9a01cd…" on Base Sepolia. Correct for the stOLAS
standard-staking path, but inconsistent with the legacy OLAS references
further up. At minimum the runbook should lead with `stOLAS` for Phase 1b.

---

### Nit-3 — `jinn fund-requirements` JSON envelope contains `blocks: "bootstrap"` but no `blocks: "run"` / `"submit-intent"` rows are emitted pre-bootstrap

**Status on HEAD: NOT FIXED.** No `--forecast` flag on HEAD;
`fund-requirements --help` still shows only `--human` / `--config` /
`--password-fd` options.

**Where:** `client/src/cli/commands/fund-requirements.ts:124-136`.

The row only contains the master-ETH requirement. The downstream roles
(Safe bond, reward liquidity, gas for agents) never show up until those
wallets exist. That is technically correct, but operators reading the
schema see a `blocks` enum with 4 values and cannot discover — from this
command alone — what the complete funding set looks like. A `--forecast`
mode that projects all gates based on `targetServices` and the bundled
deployment would cut hours out of the onboarding.

---

### Nit-4 — Drill's fresh `$HOME` discovery: `~/.jinn-client` is documented but not surfaced on first run

**Status on HEAD: NOT FIXED.** HEAD `jinn status` output still does not
include a `paths` stanza; earning directory only surfaces from `jinn init`.

**Where:** `client/README.md:121-140` (config table) and
`client/src/cli/commands/init.ts:77` (emits `keystoreDir`).

`init` prints `keystoreDir`, which is useful. But `doctor`, `status`,
`fleet`, `balance` never mention the state directory in their output. An
operator who deletes `/tmp/jinn-onboarding-drill/home` in testing cannot
tell from any inspection verb where the state lives (short of reading the
README or the env-var table). Add a `paths: {earningDir, dbPath}` stanza to
`status` / `doctor`.

---

## Minimal reproduction script

```bash
rm -rf /tmp/drill && mkdir -p /tmp/drill
HOME=/tmp/drill/home
JINN_PASSWORD=test
npx --yes -p @jinn-network/client@latest jinn init                   # master A
npx --yes -p @jinn-network/client@latest jinn fund-requirements      # master B  (different!)
npx --yes -p @jinn-network/client@latest jinn bootstrap              # master C  (different again!)
npx --yes -p @jinn-network/client@latest jinn doctor                 # reports "no keystore yet"
npx --yes -p @jinn-network/client@latest jinn logs                   # empty stdout
npx --yes -p @jinn-network/client@latest jinn submit-intent \
    --id t --description t --dry-run                                 # "Would post intent 't' from 0x"
```

## HEAD re-verification matrix

Built locally from the worktree HEAD (`3f772789` before this edit) and
reran every finding from a clean `/tmp/jinn-head-drill/home`.

| Finding | HEAD status | Evidence |
|---|---|---|
| Blocker-1 (wallet drift) | Fixed (unreleased) | bootstrap.ts:342-352; verified `init/fund-req/bootstrap` all resolved `0x2786…0966` |
| Blocker-2 (README missing JINN_PASSWORD) | Not fixed | README line 21 unchanged; HEAD binary still exits 11 |
| Blocker-3 (submit-intent `"0x"`) | Not fixed | `Would post intent 't' from 0x` reproduced on HEAD |
| Major-1 (doctor filename) | Not fixed | doctor.ts:32 still `mnemonic.keystore.json` |
| Major-2 (empty `jinn logs`) | Not fixed | HEAD build: stdout bytes = 0 |
| Major-3 (`--human` wired narrowly) | Not fixed | version/doctor `--human` still JSON; fund-req still wei |
| Major-4 (Phase 1b docs gap) | Partial | `jinn quickstart` ships on HEAD; README does not mention it |
| Major-5 (`commit`/`digest` = `"unknown"`) | Partial | commit meta lands via CI env; digest still empty for zero-config operators |
| Major-6 (README/help parity) | Partial | HEAD help lists quickstart/plugin/update; README still doesn't |
| Minor-1 (init next-step hint) | Not fixed | JSON payload unchanged |
| Minor-2 (doctor `ok: true` for missing keystore) | Not fixed | same behaviour |
| Minor-3 (deprecation noise) | Not fixed | dep tree unchanged |
| Minor-4 (keys backup silent plaintext) | Not fixed | same behaviour |
| Minor-5 (run --help failure example) | Partial | prose only; no copy-paste example |
| Nit-1 (help omissions) | Fixed | HEAD help lists all shipping verbs |
| Nit-2 (stOLAS naming) | Not fixed | README has no stOLAS reference |
| Nit-3 (fund-requirements forecast) | Not fixed | no `--forecast` flag |
| Nit-4 (paths in inspection verbs) | Not fixed | `status` output unchanged |

## Suggested follow-up work (not done in this session)

1. Cut a patch release that carries Blocker-1's fix so the "mnemonic rotates
   on every bootstrap" behaviour stops reaching any new operator via npm.
   This is the single most valuable ship right now.
2. Fix the README quick-start `JINN_PASSWORD` inconsistency (Blocker-2) and
   add a one-line section for `jinn quickstart` in the same pass (closes
   the README half of Major-4 and Major-6).
3. Land the doctor filename fix (Major-1) and empty `jinn logs` envelope
   (Major-2) together — both are one-line changes with immediate operator
   wins.
4. Feed bundled deployments into `computeDeploymentDigest`
   (`client/src/cli/deployment-digest.ts`) so `jinn version` reports a real
   digest for zero-config operators (remainder of Major-5).
5. Short-circuit `jinn submit-intent --dry-run` when no complete service
   exists (Blocker-3) — emit a `bootstrap_required` envelope rather than a
   `"0x"` placeholder plan.

## 2026-04-18 re-drill verification

Every finding above has been addressed on a branch rebased onto
`origin/main` (which carries `cc2fffdf client: Docker acceptance gate,
jinn auth, and daemon resilience`). The `release:testnet-acceptance`
gate now completes end-to-end on Base Sepolia:

- image: `jinn-client:acceptance-local`
- commit: `74e69505bbc81e3225bfbd16cb4bab95981b8807` on
  `ale/jinn-operator-onboarding-drill` (v0.1.1)
- deployment digest: `6e98a131263c0232a1671d8905f21cc815073f97635aa48a72b5960219b171cc`
- cycles observed: 2 / 2 (both `restoration: SUCCESS` and
  `evaluation: SUCCESS` for the two deterministic desired states)
- claim-rewards tx: 1 submitted (pending 0.2748 JINN before claim)
- evidence: `client/acceptance-runs/2026-04-18T10-53-46-446Z-logm0s/`
- local gates: `yarn typecheck`, `yarn test` (316/316), `yarn build`,
  `yarn pack:smoke` (0.1.1), `yarn staking` (6/6),
  `yarn e2e` (24/24) all green

### New drill-class findings discovered during the acceptance run

The Docker acceptance surfaced five issues that were not in the original
npm-drill report. All are fixed on the re-drill branch.

#### New-1 — Major: `fund-requirements` reports `satisfied: true` while the Safe has 0 ETH

**Where:** `client/src/cli/commands/fund-requirements.ts:124-136`
+ `client/src/earning/bootstrap.ts` (funding probe).

**What happened:** After bootstrap reached `step: complete`, the Safe
(`0xa1A38dc5fece0196500F2d0F8136Eb08b1084c59`) held exactly 0 ETH.
`fund-requirements --json` still reported `satisfied: true` because the
funding probe only checks master-EOA ETH. The daemon then spent the
entire run retrying `createEvaluationJob` (which sends 99 wei as
`msg.value` to the mech for the evaluation fee) — every call reverted
with `execTransaction` wrapping the inner `insufficient funds`.

**Repro:** from a cold Safe,
`jinn fund-requirements --json` → `satisfied: true` despite
`cast balance $SAFE` returning `0`.

**Proposed fix:** the funding probe should include per-Safe native-ETH
runway. A Safe that is `complete` but holds < N × mech fee is not
runnable; surface it as a `native`/blocks=`run` requirement row.

#### New-2 — Major: `ExternalStakingDistributor.reStake` is permissioned — regular operators can't self-heal an evicted service

**Where:**
`contracts/src/vendor/stolas/ExternalStakingDistributor.sol:778-806`
vs. `client/src/earning/bootstrap.ts` (reconcile path).

**What happened:** service 27 was evicted on-chain between runs. The
bootstrap reconcile logic called `distributor.reStake(stakingProxy,
serviceId)` from the operator EOA and the tx reverted with
`UnauthorizedAccount(0xEfbd…)`. `reStake` gates on
`mapCuratingAgents[msg.sender] || mapManagingAgents[msg.sender] ||
msg.sender == owner` — a plain operator has none of those roles. In
this run the distributor owner (the deployer) had to call `reStake`
manually to unblock the gate.

**Proposed fix:** detect `UnauthorizedAccount` during the reconcile
path and fall through to "abandon the evicted service, bootstrap a new
one" rather than retrying forever. Optionally emit a
`reconcile_needed` envelope so ops know the old Safe's stOLAS bond is
stranded and needs manual cleanup.

#### New-3 — Major: Safe 1.3.0 wraps every inner execTransaction revert as `GS013`; `isRecoverableTransactionError` treated it as non-recoverable

**Where:** `client/src/tx-retry.ts:55` (pre-fix) vs.
`GnosisSafe.sol §execTransaction`
(`require(success || safeTxGas != 0 || gasPrice != 0, "GS013")`).

**What happened:** `restorer` and `delivery-watcher` both queue Safe
writes. Even with the process-local `safeLocks` Map in
`client/src/adapters/mech/safe.ts:35` serialising those writes, the
viem pre-broadcast simulate-step reads the Safe nonce, signs, and then
can race with an in-flight execution. On a nonce miss, inner
`checkSignatures` reverts with `GS026 "Invalid owner provided"` because
the signed SafeTxHash bound to nonce N no longer recovers to an owner
now that the Safe is at N+k. Safe catches that and re-reverts as
`GS013`, so viem reports `"GS013"` and the retry classifier gave up
after the first attempt. Verified on-chain: signature valid for nonce
84, Safe at 86 by execution time; `cast wallet verify` matched only
`getTransactionHash(..., 84)`.

**Fix landed:** `client/src/tx-retry.ts` — treat `GS013` as
recoverable. `executeSafeTransaction` already re-reads the nonce and
re-signs on every retry inside `withRecoverableRetry`, so this
self-heals for the race case. Truly unrecoverable GS013 still fails
after `maxAttempts` with the same error — same end state as before.
Regression test in `client/test/tx-retry.test.ts`.

#### New-4 — Major: runner env allowlist didn't forward `CLAUDE_CODE_OAUTH_TOKEN`, breaking headless Docker auth

**Where:** `client/src/runner/claude.ts:ENV_ALLOWLIST`.

**What happened:** The daemon process had `CLAUDE_CODE_OAUTH_TOKEN`
set (from `docker-compose.acceptance.yml`), but
`buildAgentEnv()` strictly filtered to an allowlist that covered
`PATH`, `HOME`, `XDG_*`, `NODE_*`, etc. — and nothing Claude-auth.
Every spawned `claude -p …` exited with `Not logged in · Please run
/login` even though the parent daemon had a valid token.

**Fix landed:** added `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`
to the allowlist with a comment explaining these are Claude
credentials (not Jinn operator secrets) and scoped forwarding is
intentional.

#### New-5 — Minor: Docker-compose mount at `/root/.claude` leaves `/root/.claude.json` on ephemeral overlay

**Where:** `client/docker-compose.yml:32`,
`client/docker-compose.acceptance.yml:20`.

**What happened:** The acceptance volume mounts at `/root/.claude`
(directory), which persists the credentials file Claude writes at
`/root/.claude/.credentials.json`. Claude Code also writes a main
config to `/root/.claude.json` (file, one level up, outside the
mount) with non-secret state like `migrationVersion`,
`opusProMigrationComplete`, `userID`. That file is wiped on every
`docker compose run --rm`; Claude warns about it on every restart
(`"Claude configuration file not found at: /root/.claude.json. A
backup file exists at …"`) but does not block. Still noisy, and
confused the debugging of New-4.

**Fix landed:** `client/Dockerfile` symlinks
`/root/.claude.json → /root/.claude/claude.json` so the main config
lives inside the mounted directory.

Note: this commit was originally written before I discovered that the
OAT flow uses `CLAUDE_CODE_OAUTH_TOKEN` env var, not file storage.
The symlink is still useful belt-and-braces defence for the warning
chatter and for older Claude-CLI versions that stored more state in
`.claude.json`, but it is no longer on the critical path for Docker
auth.

#### New-6 — Process: deterministic acceptance prompts lived on origin/main but not on the drill-fix branch

**Where:** `client/scripts/lib/acceptance-operator-config.mjs
:buildAcceptanceDesiredStates`.

**What happened:** The user wrote concrete, verifiable prompts for the
acceptance harness on 2026-04-16 (merged to main as `cc2fffdf`). The
drill-fix branch was forked before that merge and was still using the
earlier vague template
(`"Release acceptance desired state N for <runId>."`). The evaluator
Claude correctly returned `FAILURE` on the vague prompts, which looked
like "the protocol is broken" until the divergence was caught. Rebase
onto `origin/main` pulled the concrete prompts back in and the
harness went green on the first retry after rebase.

**Proposed fix (process, not code):** `yarn
release:testnet-acceptance` should refuse to run if the current
branch's merge-base with `origin/main` is more than ~2 commits behind,
or at least surface a warning. Catching this earlier would have saved
about an hour of investigation this session.

## 2026-04-18 follow-up commits: remaining re-drill findings

The first re-drill pass landed the retry-classifier and Claude-OAT fixes
(commit `74e69505`). After the user asked for every finding closed
before ship, three further fixes landed at `484ef5a1`:

- **New-1** `fund-requirements` now probes every completed service's
  Safe native balance and emits a `native` / `blocks: run` row when
  below `chain.minSafeEth`. The daemon's balance-topup-loop still
  auto-refills at runtime, but CLI paths (acceptance gate,
  `submit-intent`) that touch the Safe before any topup tick now see
  the gap in `fund-requirements` output.
- **New-2** `recoverEvictedService` catches `UnauthorizedAccount`
  (text + `0x32b2baa3` selector) from `distributor.reStake` and raises
  a structured error. `formatBootstrapOperatorMessage` gained a
  matching branch that preserves the full actionable guidance
  (`setCuratingAgents([operator], [true])` or abandon-and-rebootstrap)
  instead of truncating to 220 chars. The misleading comment "master
  EOA is a curating agent (recorded when it called stake())" was
  replaced with an explanation of why that assumption is false
  (`stake()` only writes to the guard-scoped mapping, not the
  top-level `mapCuratingAgents` that `reStake()` reads).
- **New-6** `testnet-acceptance-docker.mjs` now runs `git fetch
  origin main` + merge-base and warns (non-fatal) when the current
  branch is ≥2 commits behind `origin/main`. Silently skipped when
  `origin/main` can't be reached (offline / shallow). The exact case
  that cost us half a day today — the deterministic prompts being on
  main but missing from the drill branch — will now surface at the
  start of every acceptance run.

Regression coverage in `test/earning/bootstrap.test.ts`: new case
"surfaces an actionable error when distributor.reStake reverts with
UnauthorizedAccount" — `317/317` tests green.

### Findings explicitly out of scope for v0.1.1

- **Minor-3** (deprecation noise). The `ipfs-http-client` + `cids` +
  `multicodec` deprecation warnings come in via
  `@jinn-network/mech-client-ts@0.0.6`, which is an external package
  that still pins js-IPFS. Silencing at our level would require
  forking that package or pinning unrelated transitives via
  `resolutions`, both of which are beyond a CLI-ergonomics patch
  release. Filed as a follow-up on the upstream mech client.
- **Nit-3** full `--forecast` mode for `fund-requirements`. The
  `blocks: run` Safe-ETH row landed in this release covers the
  concrete hazard that motivated the finding (operator sees
  `satisfied: true` despite an empty Safe). A proper forecast that
  projects bond amounts for unbootstrapped services, reward-liquidity
  headroom, etc., is new-feature work and should be specced
  separately.

## Release status

- Branch: `ale/jinn-operator-onboarding-drill` (local only).
- Tip: `484ef5a1` (v0.1.1, acceptance-green pre-refactor; re-drill pending
  after refactor to confirm the three follow-up fixes don't regress).
- Pending: local rebuild + re-run `yarn release:testnet-acceptance`
  against the 484ef5a1 tip (waiting on docker daemon to come back up).
  Then `git push origin ale/jinn-operator-onboarding-drill` +
  `git tag client-v0.1.1 && git push origin client-v0.1.1` which
  triggers `.github/workflows/npm-publish.yml` (publishes
  `@jinn-network/client@0.1.1` with `latest` dist-tag via OIDC
  trusted publishing) and `.github/workflows/docker.yml` (pushes
  OCI image to GHCR).
- Not pushed autonomously — tag push is the documented checkpoint in
  the release plan.
