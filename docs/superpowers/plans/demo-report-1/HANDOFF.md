# Demo-1 confirmatory run — session handoff

**Written 2026-08-19 07:55 UTC.** Everything needed to finish the run and seal the report.
You have no prior context; this file is the context.

---

## 0. First action: the auth token is exhausted

The six droplets run Claude Code headlessly using a `CLAUDE_CODE_OAUTH_TOKEN` in
`~/.demo1-droplet-auth` on the operator's Mac. That token's subscription window is spent.

Ask the operator to mint a fresh token from the other account and write it to the same file:

```bash
claude setup-token
```

```bash
printf "export CLAUDE_CODE_OAUTH_TOKEN='<token>'\n" > ~/.demo1-droplet-auth && chmod 600 ~/.demo1-droplet-auth
```

Then push it to every droplet (the file must contain exactly one `export` line — a bare
`KEY=value` line breaks `source`):

```bash
for ip in 134.209.206.15 167.71.1.24 165.22.193.219 178.128.248.89 142.93.129.19 164.92.214.28; do
  ssh -i ~/.ssh/demo1_droplet_ed25519 -o UserKnownHostsFile="$HOME/.ssh/demo1_known_hosts" runner@$ip \
    'cat > /home/runner/.demo1-env && chmod 600 /home/runner/.demo1-env' < ~/.demo1-droplet-auth
done
```

Smoke-test before trusting it:

```bash
ssh -i ~/.ssh/demo1_droplet_ed25519 -o UserKnownHostsFile="$HOME/.ssh/demo1_known_hosts" runner@134.209.206.15 'source ~/.demo1-env && export PATH=~/.npm-global/bin:$PATH && cd /tmp && claude -p "Reply with exactly: READY" --model claude-haiku-4-5-20251001 --permission-mode bypassPermissions'
```

An `ANTHROPIC_API_KEY=...` line works instead if metered billing is preferred (~$30–80 for the
remainder). **The old token appears in this session's transcript and should be revoked.**

---

## 1. What this experiment is

**Question.** Holding task, model, harness, instruction bytes, non-instruction resources and
environment fixed, does the *delivery mechanism* for curated instructions change agent success?

- **Arm A** — instructions as a native Agent Skill (`--plugin-dir`, progressive disclosure)
- **Arm B** — byte-identical text flattened into root `CLAUDE.md`
- **Arm C** — no instructions (manipulation check; if C matches A/B the task measures nothing)

**Subject:** `claude-haiku-4-5-20251001`. **Corpus:** SkillsBench v1.1 pinned at
`b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af`. **Design:** flat — every one of the 41
statically-admitted tasks gets A×5, B×5, C×2 = **492 cells**. No task was selected or dropped on
any outcome; the amd64 build probe excluded nothing.

**Why Colophon:** the run is the demo. Every cell becomes signed Execution Evidence flowing
through a pre-declared Analysis Manifest into a Cohort, Matrix and signed Report that a stranger
re-verifies offline with one command. This exercises the product's **evidence-import** mode
(runs Colophon did not dispatch) — the counterpart to the commissioned Harbor/TB2.1 path.

---

## 2. State as of this handoff

**432 / 492 cells, 29 / 41 oracle controls.** All recorded cells are valid (agent exit 0).

| droplet | IP | cells | controls | assigned tasks remaining |
|---|---|---:|---:|---|
| demo1-w1 | 134.209.206.15 | 86 | 7 | exam-block-sequencing, radar-vital-signs |
| demo1-w2 | 167.71.1.24 | 19 | 0 | ada-bathroom-plan-repair, drone-planning-control |
| demo1-w3 | 165.22.193.219 | 57 | 0 | 7 tasks, several partial |
| demo1-w4 | 178.128.248.89 | 96 | 8 | llm-prefix-cache-replay |
| demo1-w5 | 142.93.129.19 | 90 | 7 | multilingual-video-dubbing |
| demo1-w6 | 164.92.214.28 | 84 | 7 | threejs-to-obj |

Tasks were re-sharded once (w2 was 16 h behind), so `tasks.txt` no longer matches the original
even split — trust `tasks.txt` on each host, not any earlier plan.

**Watch progress:** `tail -f /tmp/droplet/supervisor.log`

---

## 3. Infrastructure

| item | value |
|---|---|
| SSH | `ssh -i ~/.ssh/demo1_droplet_ed25519 -o UserKnownHostsFile="$HOME/.ssh/demo1_known_hosts" runner@<ip>` |
| droplet work dir | `/home/runner/demo1/` — `cells.json`, `controls.json`, `tasks.txt`, `cache/`, `skillsbench-arm-cell.mjs`, `run-shard.sh` |
| logs | `/home/runner/demo1/{cells,controls}.log` |
| supervisor (Mac) | `/tmp/droplet/supervisor.sh` → `/tmp/droplet/supervisor.log`; 10-min loop, drives each droplet cells → controls → done, **launches only from stopped state** |
| repo worktree | `/Users/adrianobradley/life's-work/jinn-mono/.claude/worktrees/dr-2026-08-05-round-24-a729a9` |
| branch / PR | `codex/demo1-historical-artifact-pin` → [#2729](https://github.com/Jinn-Network/mono/pull/2729) |
| cost | 6 × `s-4vcpu-8gb` ≈ $0.50/hr. **`doctl compute droplet delete --tag-name demo1` when done.** |

If the supervisor is not running: `nohup /tmp/droplet/supervisor.sh > /tmp/droplet/supervisor.log 2>&1 &`
Its `EXPECT` array holds per-droplet cell targets and must match the current re-shard (currently
`108 24 84 96 96 84`).

---

## 4. The lock — immutable, already anchored

Committed **before any confirmatory cell existed**, then time-anchored:

| | |
|---|---|
| declaration digest | `sha256:a31405a150a66753273e7b645e5b1391265564c9f0d33df814e4af93bdeb7a7e` (492 cells) |
| manifest digest | `sha256:822b2f7469dc2e58a3e72eee32688614d296ba20fc381d9a074e3935a68622b3` |
| lock commit | `447e311c9` (pushed 2026-08-18 10:44 UTC) |
| anchor commit | `ec9761220` — RFC 3161 token from freetsa.org, signed **11:11:07 GMT**, verified offline; plus 3 pending OpenTimestamps calendar proofs |
| anchors | `docs/superpowers/plans/demo-report-1/anchors/` |

An earlier dispatch started *before* the anchor existed. Per the integrity-providers design
(PR #2786), a lock anchored after dispatch is a silently weaker fact — so those cells were
**destroyed unread** and dispatch restarted after the token verified. All current confirmatory
evidence postdates the anchor.

**Do not re-run `demo1-preregister.mjs` with `SKILLSBENCH_DEMO1_STAGE=final`.** It would reseal
the manifest and break the byte-equality that proves the lock preceded the data. The declaration
in `src/method/skillsbench-demo1-current.ts` is frozen.

---

## 5. Inviolable rules

1. **Never record a cell whose agent exited nonzero.** A nonzero exit is infrastructure failure
   (usage limit, auth, crash) — never a task verdict. The runner backs off up to 12 times and then
   records *nothing*; fail-closed admission demands the cell later. Recording it as reward 0
   manufactures a fail from a non-attempt. 343 such cells were already purged once.
2. **Never merge exploration cells into the confirmatory set.** `E1-arm-cells.v1.json` (221
   pre-lock laptop cells: screens, pilot) stays separate from
   `E1-demo1-confirmatory-cells.v1.json`. Merging collides replicate indices and lets pre-lock,
   already-observed evidence into the confirmatory denominator.
3. **Fail-closed denominator.** A missing, unparseable, or wrong-model declared cell fails the
   report build. Never shrink the denominator to make a build pass.
4. **The conditioning rule is pre-declared, not chosen now.** A task enters the paired estimate
   iff C = 0 in every replicate AND max(mean A, mean B) > 0. It is sealed in the manifest with a
   ±15 pp (150000 ppm) equivalence margin. Do not tune it after seeing results.
5. **Disclose on the report's face** (not footnotes): pilot scale vs the official 21-unit /
   13-cluster floor, the flat no-selection population, the host-agent deviation, and the model.

---

## 6. Remaining work

**a. Finish the fleet.** Supervisor handles it once the token is refreshed. Cells first, then
oracle controls per droplet (`run-shard.sh controls` — upstream oracle must pass and blank
submission must fail on that host; a zero from an unvalidated instrument is uninterpretable).

**b. Collect and merge** into `docs/superpowers/plans/demo-report-1/E1-demo1-confirmatory-cells.v1.json`,
shape `{schema, cells: {"<task>/<arm>/r<n>": {...}}}` — same shape as `E1-arm-cells.v1.json`.
Merge `controls.json` from all six into a host-control-evidence artifact alongside.
Assert: exactly 492 cells, every `agentExit === 0`, no duplicate keys across shards.

**c. Seal** (from `packages/benchmark-product/core`):

```bash
SKILLSBENCH_DEMO1_REPORT=1 SKILLSBENCH_DEMO1_STAGE=final yarn vitest run src/conformance/skillsbench-demo1-report.external.test.ts
```

Writes `E1-demo1-evidence-bundle.v1.json` + `demo1-report.v1.json`. Fail-closed admission runs
first and throws with the complete list of any missing cells.

**d. Verify:**

```bash
cd packages/benchmark-product/core && yarn demo1:verify
```

22 offline checks: re-admission, statistic recomputation, digest integrity, cohort/matrix/report
chain verification, ed25519 signatures, artifact-to-cells binding, **and preregistration
byte-equality**. All must pass.

**e. Write `demo1-report.md`** — the human-readable report. State the paired A−B estimate with
interval and variance decomposition, the manipulation-check evidence, the per-task funnel (41
tasks → how many informative), and §5.5's disclosures on its face. Add a v4 row to
`E1-pre-run-freeze.md`'s artifact table (append-only; never edit existing rows).

**f. Ship:** commit, push, confirm CI green, confirm the three historical STOP artifacts still
byte-identical (`node --test .github/scripts/demo1-historical-artifacts.test.mjs`), confirm 0
behind `origin/next`. Then **delete the droplets**.

---

## 7. Gotchas already paid for

- `timeout` does not exist on macOS. The runner has internal bounds; don't wrap it.
- `FROM --platform=linux/amd64 ubuntu:20.04` — the image reference is the first **non-flag**
  token. Naive `\S+` pulls the flag and the error looks nothing like a bad Dockerfile.
- Blob buffer must be ≥512 MB: `sec-financial-report` ships two 82 MB zips (~110 MB base64).
  Under-sizing gives a bare `spawnSync gh ENOBUFS`.
- `docker pull` consults the credential helper even for public images; a wedged helper hangs
  forever. Resolve the digest from the local image first (the runner does).
- Container-root litter breaks cleanup on native Linux (invisible on Docker Desktop, which
  uid-maps). The runner falls back to `sudo rm -rf`.
- `pkill -f run-shard.sh` over SSH matches the SSH command itself and kills the connection. Use
  a bracket: `pkill -f "run-shard[.]sh"`.
- Never hot-swap a shell script under a running bash — it reads by byte offset and dies with a
  phantom syntax error. Stop, ship, relaunch.
- macOS `openrsync` aborts against GNU rsync; use `tar` over ssh. Bulk uploads from the Mac to
  6 hosts in parallel fail — upload once, fan out droplet-to-droplet.
- zsh does not word-split unquoted variables; inline ssh flags rather than `$OPTS`.
- The protocol's I-JSON admits **integers only**. Sealed statistics are parts-per-million ints;
  the readable floats live in the summary file.
- Manifest `preregistration` and cohort `assurance.timing` are closed enums — `post-hoc-exploratory`
  and `retrospective-artifacts-only` for imported evidence. `analysisPlan` must be sorted by id.
- Sealing errors carry their issues in `error.errors`; the message alone says nothing.

---

## 8. What is already proven

- Chain works end to end: the pilot report (63 exploration cells) sealed and verified all 22
  checks — commits `ef23860d7`, `f8a82b7ab`.
- Instrument calibrated on the laptop: oracle 13/13, blank 0/13 (`colophon-calibration-report.v1.json`).
- amd64 build probe: 41/41 tasks build; zero exclusions.
- Pilot result, for orientation only (**not** the confirmatory answer): paired A−B −0.095
  (95% CI −0.328 to +0.138, n=7); manipulation check C 0/21 with +0.476 uplift; task
  heterogeneity 0.00 — variance sat below the replicate-noise floor, which is why the
  confirmatory design raised replicates rather than tasks.
