# Dependabot migration tail (#1596) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the three residual Dependabot major-ignores (`chai`, `@scure/bip39`, `lucide-react`) by landing the majors first-party, then removing those ignore entries from every npm block in `.github/dependabot.yml`.

**Architecture:** Approach A from `docs/superpowers/specs/2026-07-23-dependabot-migration-tail-1596-design.md` — four surgical commits (bip39 regression → bip39 bump → chai bump → lucide unify + dependabot closeout). No product behavior change beyond package packaging/import paths. `legacy/**` stays untouched.

**Tech Stack:** Yarn 4 (`client/`, `contracts/`), npm workspaces (`apps/jinn-agent`), Vitest, Hardhat/Mocha/Chai, Vite + TypeScript SPAs, Dependabot v2 YAML.

**Pinned worktree:** `/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree` (detached — logical branch `autopilot/1596`; do **not** `git checkout autopilot/1596`). Draft PR #2024 is coordinator-owned.

## Global Constraints

- Shape: `chore` — integration tests / suite green on touched surfaces; no feature work.
- Execute all three majors (Approach A); do **not** defer any residual.
- `@scure/bip39` → `^2.2.0`; wordlist import must be `@scure/bip39/wordlists/english.js`.
- `chai` → `^6` in `/contracts` only; keep `@types/chai` at current `^5.2.3` unless `tsc`/yarn complains.
- `lucide-react` → single major-**1** caret on SPA + jinn-agent web + bootstrap-installer; **never** edit `legacy/**`.
- Chosen lucide caret (headless decision): `^1.17.0` — matches current SPA; bumps jinn-agent off `0.577.x` without forcing a SPA lockfile churn to latest 1.x. (If install fails to resolve, fall back to `^1.25.0` on all three manifests.)
- After majors land: **remove** `chai`, `@scure/bip39`, and `lucide-react` ignore stanzas from **all 12** npm ecosystem entries; do not leave “deferred to #1596” ignores for shipped majors.
- Do not change wallet strength (128 bits / 12 words), HD path `m/44'/60'/0'/0/{index}`, or keystore encryption format.
- Do not add `apps/jinn-agent` to Dependabot allowlist; do not migrate other ignored majors (`vitest`, `typescript`, `react`, Hardhat, …).
- Coordinator owns push / PR ready / GitHub mutation — implementer only writes local commits in this worktree.
- Prefer small local commits the coordinator can checkpoint (one logical landable unit each).

---

## File Structure

| Path | Role |
|---|---|
| `client/test/earning/wallet.test.ts` | Add BIP39 known-vector seed-hex regression (Task 1). |
| `client/package.json` + `client/yarn.lock` | Bump `@scure/bip39` to `^2.2.0` (Task 2). |
| `client/src/earning/wallet.ts` | Fix wordlist import to `…/english.js` (Task 2). |
| `contracts/package.json` + `contracts/yarn.lock` | Bump `chai` to `^6` (Task 3). |
| `client/src/dashboard/spa/package.json` + `client/yarn.lock` | Align `lucide-react` to `^1.17.0` if not already (Task 4). |
| `apps/jinn-agent/web/package.json` | Bump `lucide-react` `^0.577.0` → `^1.17.0` (Task 4). |
| `apps/jinn-agent/apps/bootstrap-installer/package.json` | Same lucide bump (Task 4). |
| `apps/jinn-agent/package-lock.json` | npm workspace lock refresh after lucide bumps (Task 4). |
| First-party `*.tsx` under SPA / jinn-agent | Only if `tsc` reports renamed/removed icon exports (Task 4). |
| `.github/dependabot.yml` | Delete three ignore names from all 12 npm blocks; header prose for #1596 closeout (Task 5). |

**Out of scope files (must remain unchanged):**

- `legacy/jinn-cli-agents-reference/**` (incl. `lucide-react ^0.560.0`, `chai ^4`)
- Other Dependabot ignore names (`vitest`, `typescript`, `react`, `hardhat`, …)

---

## AC ↔ Task mapping

| Acceptance criterion | Task(s) |
|---|---|
| AC1 — `chai` 5→6 execute or defer | Task 3 (execute `^6`; Hardhat `yarn test`) |
| AC2 — `@scure/bip39` 1→2 with entropy/checksum verification | Tasks 1–2 (seed-hex regression first; then bump + `.js` import) |
| AC3 — `lucide-react` unify to one major across first-party manifests | Task 4 (major 1; exclude `legacy/**`) |
| AC4 — Dependabot ignores point at #1596 / closeout | Task 5 (remove the three ignore entries after majors land; header no longer cites #768 as live home for these three) |

---

### Task 1: BIP39 known-vector seed-hex regression (TDD — red first optional, green on 1.x)

**Files:**
- Modify: `client/test/earning/wallet.test.ts`
- Test: same file (Vitest)

**Interfaces:**
- Consumes: `mnemonicToSeedSync` from `@scure/bip39` (direct import in test — does not require exporting a new wallet helper)
- Produces: failing gate if a future major changes PBKDF2/seed bytes for the standard vector

- [ ] **Step 1: Add the known-vector seed assertion**

Append this test inside the existing `describe('HD wallet', …)` block in `client/test/earning/wallet.test.ts`. Add the import at the top of the file:

```typescript
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils';
```

If `@noble/hashes/utils` is awkward to import in this package, use Node instead:

```typescript
import { mnemonicToSeedSync } from '@scure/bip39';
```

and hex-encode with:

```typescript
function seedHex(mnemonic: string): string {
  const seed = mnemonicToSeedSync(mnemonic);
  return Buffer.from(seed).toString('hex');
}
```

Test body (full fixture hex from design-time v1≡v2 evidence / BIP39 PBKDF2):

```typescript
  it('produces the BIP39 known-vector seed for abandon…about (empty passphrase)', () => {
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    // BIP39 test vector — empty passphrase; identical under @scure/bip39 v1.6.0 and v2.2.0
    const expected =
      '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4';
    const seed = mnemonicToSeedSync(mnemonic);
    expect(Buffer.from(seed).toString('hex')).toBe(expected);
  });
```

Do **not** change `wallet.ts` in this task.

- [ ] **Step 2: Run the wallet tests (expect PASS on current `@scure/bip39@^1.4.0`)**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree/client"
yarn test earning/wallet
```

Expected: all tests in `client/test/earning/wallet.test.ts` PASS, including the new known-vector test.

If the file filter does not match Vitest’s path convention, use:

```bash
yarn vitest run test/earning/wallet.test.ts
```

(after the usual `yarn test` preamble deps are built — prefer `yarn test test/earning/wallet.test.ts` if the root script accepts a path; otherwise the vitest-run form above once SDK/plugin/core are built).

- [ ] **Step 3: Commit**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree"
git add client/test/earning/wallet.test.ts
git commit -m "$(cat <<'EOF'
test(client): pin BIP39 abandon…about seed hex for #1596

Locks the empty-passphrase seed bytes before bumping @scure/bip39 1→2
so a packaging major cannot silently change PBKDF2 output.

EOF
)"
```

---

### Task 2: Bump `@scure/bip39` 1→2 + wordlist `.js` import

**Files:**
- Modify: `client/package.json` (`"@scure/bip39": "^1.4.0"` → `"^2.2.0"`)
- Modify: `client/yarn.lock` (via `yarn install`)
- Modify: `client/src/earning/wallet.ts` (wordlist import path)
- Test: `client/test/earning/wallet.test.ts` (existing + Task 1)

**Interfaces:**
- Consumes: Task 1 seed-hex gate
- Produces: client resolves `@scure/bip39@2.x`; `wallet.ts` imports wordlist via exports-compliant path

- [ ] **Step 1: Bump the dependency**

In `client/package.json`, change:

```json
"@scure/bip39": "^2.2.0"
```

- [ ] **Step 2: Fix the wordlist import**

In `client/src/earning/wallet.ts`, replace:

```typescript
import { wordlist } from '@scure/bip39/wordlists/english';
```

with:

```typescript
import { wordlist } from '@scure/bip39/wordlists/english.js';
```

Leave `generateMnemonic`, `mnemonicToSeedSync`, and `validateMnemonic` imports unchanged.

- [ ] **Step 3: Install**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree/client"
yarn install
```

Expected: lockfile updates `@scure/bip39` to a 2.2.x resolution; exit 0.

- [ ] **Step 4: Re-run wallet tests**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree/client"
yarn test earning/wallet
```

Expected: PASS — including known-vector seed hex identical to Task 1 fixture; encrypt/decrypt and derivation tests still green.

- [ ] **Step 5: Commit**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree"
git add client/package.json client/yarn.lock client/src/earning/wallet.ts
git commit -m "$(cat <<'EOF'
chore(client): bump @scure/bip39 to ^2.2.0 for #1596

v2 is ESM packaging; wordlist subpath needs .js. Seed/entropy for the
standard abandon…about vector matches v1 (regression gated in prior commit).

EOF
)"
```

---

### Task 3: Bump `chai` 5→6 in `/contracts`

**Files:**
- Modify: `contracts/package.json` (`"chai": "^5.3.3"` → `"^6"`)
- Modify: `contracts/yarn.lock`
- Do **not** change test assertion call sites (they already use `import { expect } from 'chai'`)

**Interfaces:**
- Consumes: Hardhat toolbox chai-matchers peer `chai: '>=5.1.2 <7'`
- Produces: contracts suite green on chai 6.x

- [ ] **Step 1: Bump chai**

In `contracts/package.json` devDependencies:

```json
"chai": "^6"
```

Keep `"@types/chai": "^5.2.3"` unless Step 3 surfaces a type error — then only bump/remove types if required (no `@types/chai@6` existed at design time).

- [ ] **Step 2: Install**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree/contracts"
yarn install
```

Expected: resolves `chai@6.x` (e.g. 6.2.2); exit 0.

- [ ] **Step 3: Run Hardhat tests**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree/contracts"
yarn test
```

Expected: exit 0, all Hardhat suites pass. If anything fails on deep `chai/lib/*` imports, fix only that import to the public `chai` entry — grep first:

```bash
rg -n "from ['\"]chai/" test/
```

(design-time: zero deep imports; expect empty).

- [ ] **Step 4: Commit**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree"
git add contracts/package.json contracts/yarn.lock
git commit -m "$(cat <<'EOF'
chore(contracts): bump chai to ^6 for #1596

Packaging-only major; public expect() API unchanged. Hardhat chai-matchers
peer already allows chai <7.

EOF
)"
```

---

### Task 4: Unify first-party `lucide-react` to major 1

**Files:**
- Modify: `client/src/dashboard/spa/package.json` — ensure `"lucide-react": "^1.17.0"`
- Modify: `apps/jinn-agent/web/package.json` — `"lucide-react": "^0.577.0"` → `"^1.17.0"`
- Modify: `apps/jinn-agent/apps/bootstrap-installer/package.json` — same
- Modify: `client/yarn.lock` and/or `apps/jinn-agent/package-lock.json` as install updates
- Possibly modify: first-party TSX icon imports **only if** typecheck fails (design probe: icons in use still export on 1.x; no `Github` brand icons in first-party)

**Interfaces:**
- Consumes: existing `from 'lucide-react'` named exports in SPA + jinn-agent
- Produces: all three in-scope manifests declare the same major-1 caret; legacy manifests unchanged

- [ ] **Step 1: Confirm in-scope vs out-of-scope manifests**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree"
rg -n '"lucide-react"' --glob '**/package.json'
```

Expected before edits: SPA `^1.17.0`; jinn-agent web + bootstrap-installer `^0.577.0`; legacy three at `^0.560.0`. **Do not edit legacy paths.**

- [ ] **Step 2: Align caret strings**

Set all three first-party manifests to:

```json
"lucide-react": "^1.17.0"
```

- [ ] **Step 3: Install SPA (Yarn workspace from client root)**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree/client"
yarn install
```

- [ ] **Step 4: Install jinn-agent npm workspaces**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree/apps/jinn-agent"
npm install
```

Expected: `package-lock.json` moves `lucide-react` for `web` and `apps/bootstrap-installer` onto 1.x.

- [ ] **Step 5: Typecheck / build first-party consumers**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree/client/src/dashboard/spa"
yarn build
```

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree/apps/jinn-agent/web"
npm run typecheck
```

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree/apps/jinn-agent/apps/bootstrap-installer"
npm run typecheck
```

Expected: exit 0. On missing-export errors, replace the icon with the lucide v1 equivalent (or nearest existing named export used elsewhere in-tree) — do not introduce new icon libraries.

- [ ] **Step 6: Verify legacy untouched + unified caret**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree"
rg -n '"lucide-react"' --glob '**/package.json'
git diff --stat -- legacy/
```

Expected: three first-party lines show `^1.17.0`; legacy still `^0.560.0`; `git diff --stat -- legacy/` empty.

- [ ] **Step 7: Commit**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree"
git add \
  client/src/dashboard/spa/package.json \
  client/yarn.lock \
  apps/jinn-agent/web/package.json \
  apps/jinn-agent/apps/bootstrap-installer/package.json \
  apps/jinn-agent/package-lock.json
# plus any TSX fixes if Step 5 required them
git commit -m "$(cat <<'EOF'
chore: unify first-party lucide-react on major 1 for #1596

SPA + jinn-agent web + bootstrap-installer share ^1.17.0. legacy/**
archives stay on 0.560.x (Dependabot excludes legacy/).

EOF
)"
```

**Ops note (do not file in this PR):** a later jinn-agent subtree sync may reintroduce `0.x` until upstream lands 1.x — follow-up outside #1596.

---

### Task 5: Remove the three Dependabot ignore entries + header closeout

**Files:**
- Modify: `.github/dependabot.yml`

**Interfaces:**
- Consumes: Tasks 2–4 landed (majors already in tree)
- Produces: no `ignore` for `chai` / `@scure/bip39` / `lucide-react` on any npm entry; header documents #1596 closeout for these three library residuals

There are **12** npm `package-ecosystem` entries (directories: `/client`, `/client/src/dashboard/spa`, `/contracts`, `/packages/indexer`, `/packages/indexer/explorer`, `/packages/sdk`, `/packages/indexer-enrichment`, `/packages/autopilot`, `/apps/broadcast-bot`, and three under `/examples/external-harnesses/…`). Each duplicates the ignore block — edit **every** copy (YAML aliases are unsupported).

- [ ] **Step 1: Update the top-of-file prose**

Replace the header sentences that treat #768 as the sole closeout home for *these* library majors. Keep framework-ignore wording for remaining ignores. Concrete replacement for lines ~13–21:

```yaml
#   - A short list of framework majors is `ignore`-d below — these are
#     known migrations tracked in #768 (and later follow-ups). The ignore
#     is per-package, not a blanket "no majors" rule: anything not in the
#     list still surfaces as a PR, which is how we hear about drift.
#   - Library residuals chai / @scure/bip39 / lucide-react from the
#     2026-05-27 wave closed via #1596 (majors landed; ignore lines removed).
#
# Adding a new live npm manifest? Add an entry below, copying the inline
# `ignore:` block verbatim (see the note at the first npm entry). To accept
# a major bump that's currently ignored, remove that dependency's line from
# the ignore block on EVERY npm entry AND close out the migration tracking
# issue for that package.
```

- [ ] **Step 2: Delete the three ignore stanzas from every npm block**

In each of the 12 npm `ignore:` lists, remove these three entries (and only these):

```yaml
      - dependency-name: "chai"
        update-types: ["version-update:semver-major"]
```

```yaml
      - dependency-name: "@scure/bip39"
        update-types: ["version-update:semver-major"]
```

```yaml
      - dependency-name: "lucide-react"
        update-types: ["version-update:semver-major"]
```

If removing `chai` leaves the Hardhat comment block looking odd, keep the `hardhat` / `@nomicfoundation/*` ignores and the `# Hardhat ecosystem — tracked in #768` comment; only delete the `chai` stanza under it.

Also delete or rewrite the comment line `# Library majors with non-trivial API surface — tracked in #768` **only if** it becomes inaccurate after removing bip39/lucide — leave it if `@hono/node-server` / `sonner` / `zod` / `better-sqlite3` remain under that comment.

- [ ] **Step 3: Verify zero residual ignores for the three packages**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree"
rg -n 'dependency-name: "(chai|@scure/bip39|lucide-react)"' .github/dependabot.yml
```

Expected: **no matches**.

```bash
rg -n '#768' .github/dependabot.yml | head -40
```

Expected: remaining `#768` cites refer only to framework / Hardhat / other still-ignored packages — not as the live home for chai/bip39/lucide. Header should mention `#1596` for those three.

- [ ] **Step 4: YAML parse sanity**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/dependabot.yml')); print('yaml ok')"
```

Expected: `yaml ok`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree"
git add .github/dependabot.yml
git commit -m "$(cat <<'EOF'
chore(dependabot): drop chai/bip39/lucide major ignores after #1596

Majors landed first-party; removing ignore lines so the next major can
surface honestly. Header notes #1596 closeout for these three residuals.

EOF
)"
```

---

## Final verification (whole chore)

Run after Tasks 1–5:

```bash
cd "/Users/adrianobradley/.jinn-client/autopilot/attempts/v2/cursor-live/implement/issue-1596-a3ae9e9b-01de-4cc6-b1c0-8fde68345b85/worktree"

# AC2
(cd client && yarn test earning/wallet)

# AC1
(cd contracts && yarn test)

# AC3
rg -n '"lucide-react"' --glob '**/package.json'
# expect first-party ^1.17.0; legacy ^0.560.0 only under legacy/

# AC4
rg -n 'dependency-name: "(chai|@scure/bip39|lucide-react)"' .github/dependabot.yml
# expect empty

git diff --stat -- legacy/
# expect empty
```

Optional broader client confidence (not required if wallet-scoped + SPA build already green):

```bash
(cd client && yarn typecheck)
```

---

## Commit strategy (coordinator checkpoints)

| Order | Commit | AC |
|---|---|---|
| 1 | `test(client): pin BIP39 abandon…about seed hex` | AC2 prep |
| 2 | `chore(client): bump @scure/bip39 to ^2.2.0` | AC2 |
| 3 | `chore(contracts): bump chai to ^6` | AC1 |
| 4 | `chore: unify first-party lucide-react on major 1` | AC3 |
| 5 | `chore(dependabot): drop chai/bip39/lucide major ignores` | AC4 |

Do not squash locally unless the coordinator asks — small commits are the checkpoint surface for Autopilot Stage 3+.

---

## Spec self-review

1. **Spec coverage:** Design §§3.1–3.3 + §4 + §5 ACs each map to Tasks 1–5; §6 order preserved (bip39 regression first); §7 non-goals honored.
2. **Placeholder scan:** No TBD/TODO; seed hex is the full 128-char fixture; lucide caret chosen (`^1.17.0`); dependabot edit is delete-not-retarget.
3. **Consistency:** Wordlist path `english.js`; package versions `^2.2.0` / `^6` / `^1.17.0` match design Approach A; legacy exclusion repeated in Task 4 and Final verification.

---

## Headless decisions logged

- Approach A (execute all three) — already ratified in design note; plan does not reopen Approach B/C.
- Lucide caret: `^1.17.0` (align to SPA) rather than bumping everyone to `^1.25.0`.
- Seed regression asserts full hex equality (not only `startsWith('5eb00bbd')`) for a stronger AC2 gate.
- Dependabot: remove ignores after land (preferred AC4 closeout), not retarget comments to #1596 while leaving ignores.
- Five small commits for coordinator checkpoints; no push / PR mutation from Plan or Implement stages without coordinator.
