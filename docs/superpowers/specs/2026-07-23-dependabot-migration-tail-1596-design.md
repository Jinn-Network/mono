# Design: Dependabot migration tail (#1596)

| Field | Value |
|---|---|
| Issue | [#1596](https://github.com/Jinn-Network/mono/issues/1596) |
| Shape | `chore` |
| Effort | High (design depth) |
| Status | Design only — do not implement from this note alone |
| Date | 2026-07-23 |
| Supersedes tracking | Open residual rows from closed [#768](https://github.com/Jinn-Network/mono/issues/768) |

## 1. Problem

`#768` closed after most 2026-05-27 Dependabot majors landed elsewhere. Three residuals remain `ignore`-d for majors in `.github/dependabot.yml`, still comment-tracked against `#768`:

| Dep | #768 / #1596 target | Current first-party | Surface |
|---|---|---|---|
| `chai` | 6 | `contracts` `^5.3.3` | Hardhat test assertions |
| `@scure/bip39` | 2.2.0 | `client` `^1.4.0` (resolves 1.6.0) | Wallet keystore mnemonic path |
| `lucide-react` | unify to major 1 | SPA `^1.17.0`; jinn-agent `^0.577.0`; legacy `^0.560.0` | Icon imports |

Without a live tracking home, ignore entries become permanent rot. Acceptance criteria require an execute-or-defer decision per residual, lucide major unification, and ignore comments/entries that point at `#1596` (or removal once the major is landed).

## 2. Approaches considered

### A — Execute all three first-party majors (recommended)

Bump `chai` 5→6 in `/contracts`, `@scure/bip39` 1→2 in `/client`, unify first-party `lucide-react` to major `1`, then **remove** the three ignore lines from every npm Dependabot entry.

- Pros: clears the migration tail; Dependabot can resurface the *next* major honestly; matches the ignore-plus-tracking contract.
- Cons: three distinct verification surfaces in one chore PR (still small LOC if surgical).

### B — Defer all three; only retarget ignore comments to `#1596`

- Pros: zero runtime risk this PR.
- Cons: fails the spirit of `#1596` (finish the tail); `@scure/bip39` stays ignored on the wallet path; lucide majors stay split.

### C — Split: execute `chai` + `lucide`, defer `@scure/bip39`

- Pros: keeps keystore path on a known 1.x line.
- Cons: rejected — v1 vs v2 produce **identical** BIP39 seed/entropy for the standard `abandon…about` vector (verified locally); remaining break is import-path only. Deferral would be theater.

**Decision (headless):** Approach A.

## 3. Per-dependency decisions

### 3.1 `chai` 5 → 6 — **EXECUTE**

**Why.** Chai `6.0.0` breaking change is packaging-only: `lib/*.js` deep imports removed; public entry is `./index.js`. Contracts already use ESM `import { expect } from 'chai'` exclusively (9 test files). `@nomicfoundation/hardhat-ethers-chai-matchers@3` peers `chai: '>=5.1.2 <7'`, so 6.x is in range. Latest at design time: `6.2.2`. `@types/chai` latest remains `5.2.3` (no `@types/chai@6`); keep current types unless `yarn` / `tsc` complains.

**Blast radius.** `contracts/package.json` + lockfile; no production code. Assertion API used (`expect(…).to.…`) is unchanged.

**Verification.** `cd contracts && yarn install && yarn test` (Hardhat suite green).

**Risk.** Low. Residual: matcher plugins that introspected chai internals (none observed in-repo).

**Not in scope.** `legacy/jinn-cli-agents-reference/contracts` still on `chai ^4` — archive / reference only; Dependabot allowlist excludes `legacy/`.

### 3.2 `@scure/bip39` 1 → 2 — **EXECUTE**

**Why.** v2 breaking surface is module packaging, not crypto:

- ESM-only (client already ESM; Node engines `>=20`, CLAUDE.md Node 22 — satisfies v2’s Node ≥20.19 floor).
- Wordlist subpath must include `.js`: `@scure/bip39/wordlists/english.js` (old path without `.js` fails `exports`).
- Public API used by `client/src/earning/wallet.ts` (`generateMnemonic`, `mnemonicToSeedSync`, `validateMnemonic`, english wordlist) is unchanged in signature.

**Entropy / checksum verification (design-time evidence).** For mnemonic `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about`:

| Check | v1.6.0 | v2.2.0 |
|---|---|---|
| `validateMnemonic` | true | true |
| `mnemonicToEntropy` hex | `00…00` (16 bytes) | identical |
| `mnemonicToSeedSync` hex | `5eb00bbd…e38e4` | identical |

So existing keystores derived under v1 remain decryptable / address-stable under v2 for the BIP39→seed step Jinn uses.

**Blast radius.**

- `client/package.json`: bump to `^2.2.0` (or `^2.0.0` caret landing 2.2.x).
- `client/src/earning/wallet.ts`: one import-path edit for the wordlist.
- Existing `client/test/earning/wallet.test.ts` already covers 12-word generation, encrypt/decrypt round-trip, and deterministic derivation for the known mnemonic — extend with an explicit **seed-hex fixture assertion** so a future major cannot silently change PBKDF2/seed bytes without a failing test.

**Verification.**

1. `cd client && yarn install && yarn test earning/wallet` (or full `yarn test` if cheap enough in CI habit).
2. Assert known-vector seed hex equals the v1/v2 shared value above (regression gate for AC2).
3. Optional smoke: generate → encrypt → decrypt still round-trips (already covered).

**Risk.** Low–medium only if TypeScript resolution or Yarn PnP disagrees with the `.js` export path — caught at typecheck/test. No intentional change to strength (`128` bits / 12 words) or derivation path (`m/44'/60'/0'/0/{index}`).

### 3.3 `lucide-react` unify to major 1 — **EXECUTE (first-party only)**

**Why.** SPA is already on major 1 (`^1.17.0`). jinn-agent manifests remain on `0.577.x`. Unification target: **major 1** for all first-party live manifests that declare the dep. Prefer align caret to current SPA line (`^1.17.0`) or bump both SPA + jinn-agent to latest 1.x (`^1.25.0` at design time) — either is fine; pick **one caret string** and apply it everywhere in scope so manifests do not drift within the major.

**Legacy / out of scope (explicit).**

| Manifest | Version | In unification? |
|---|---|---|
| `client/src/dashboard/spa/package.json` | `^1.17.0` | **Yes** (already major 1; align caret if bumping) |
| `apps/jinn-agent/web/package.json` | `^0.577.0` | **Yes** |
| `apps/jinn-agent/apps/bootstrap-installer/package.json` | `^0.577.0` | **Yes** |
| `legacy/jinn-cli-agents-reference/frontend/**` | `^0.560.0` | **No** — reference archive; Dependabot header already excludes `legacy/` from scanning |

**jinn-agent subtree note.** `.github/dependabot.yml` deliberately omits `apps/jinn-agent` because updates normally flow via subtree sync from `Jinn-Network/jinn-agent`. That does **not** waive AC3 for this mono issue: the mono tree must not leave first-party manifests on two majors. Risk: a later subtree sync can reintroduce `0.x` until upstream also lands 1.x — record as follow-up / ops note, not a deferral of AC3.

**Blast radius.** Package.json bumps + any renamed / removed icon imports. Design-time probe of `lucide-react@1.25.0` shows icons used by SPA/jinn-agent (`AlertCircle`, `AlertTriangle`, `ExternalLink`, `CheckCircle2`, `MessageSquarePlus`, `PanelRight`, `PowerOff`, `Wand2`, …) still export. Brand icons (e.g. `Github`) are gone in v1 — **no first-party usage found** in the grepped import set. Still run TypeScript / app builds to catch renames the probe missed.

**Verification.**

1. Grep first-party for `from ['\"]lucide-react['\"]`; typecheck / build SPA and jinn-agent web + bootstrap-installer.
2. Confirm all three in-scope `package.json` files declare the same major-1 caret.
3. Confirm legacy manifests unchanged.

**Risk.** Medium for jinn-agent (many icon call sites) but mostly compile-time. Low for SPA (already on 1.x). Subtree overwrite risk as above.

## 4. Dependabot.yml policy

### Current state

Every npm allowlist entry duplicates an `ignore` block. Comments for `chai`, `@scure/bip39`, and `lucide-react` still say migrations are tracked in `#768` (closed). Header docs also tell operators to close rows in `#768` when accepting a major.

### Required updates (AC4)

Because Approach A **lands** the three majors:

1. **Remove** the three `dependency-name` ignore stanzas (`chai`, `@scure/bip39`, `lucide-react`) from **every** npm ecosystem entry (12 directories at design time — keep blocks in sync by hand; YAML aliases are unsupported).
2. Do **not** leave a dangling “deferred to #1596” ignore for a major that already shipped — that would recreate the rot `#1596` exists to clear.
3. Update the top-of-file prose that still points residual major-ignore closeout only at `#768`: note that the 2026-05-27 **library** residuals (`chai`, `@scure/bip39`, `lucide-react`) closed via `#1596`; remaining framework ignores (`vitest`, `typescript`, `react`, …) may keep historical `#768` wording or get a separate tracking issue later — **out of scope** for this chore unless a one-line header clarification is cheap.
4. If any residual were instead deferred (not the case under this design), the ignore line would stay and every comment for that package would say `#1596` instead of `#768`.

### After merge

Next Dependabot weekly wave may open individual major PRs for these packages when a *new* major appears; that is intended.

## 5. Acceptance-criteria mapping

| AC | Approach |
|---|---|
| 1. `chai`: execute 5→6 or defer with rationale | **Execute** `contracts` to `chai@^6` (latest 6.2.x); verify with `yarn test` in `/contracts`. |
| 2. `@scure/bip39`: assess 1→2 with entropy/checksum verification; execute or defer | **Execute** to `^2.2.0`; fix wordlist import to `…/english.js`; add known-vector seed-hex regression; design-time v1≡v2 seed/entropy recorded above. |
| 3. `lucide-react`: unify to a single major across manifests | **Execute** major **1** on SPA + jinn-agent web + bootstrap-installer; **exclude** `legacy/**` explicitly. |
| 4. Each residual’s Dependabot ignore points at `#1596` | **Remove** the three ignore entries after majors land (preferred closeout). Comment/header cleanup so `#768` is no longer cited as the live home for these three. |

## 6. Implementation sketch (for Stage 2 plan — not this stage)

Order of work (single PR is fine; keep diffs surgical):

1. Regression first for bip39: known-vector seed assertion (may already pass on 1.x).
2. Bump `@scure/bip39` + wordlist import; re-run wallet tests.
3. Bump `chai` in contracts; run Hardhat tests.
4. Align `lucide-react` caret on in-scope manifests; fix any TS icon breaks; build/typecheck.
5. Edit `.github/dependabot.yml`: delete the three ignore names from all npm blocks; adjust header comments for `#1596` closeout.
6. Do not touch `legacy/**`.

## 7. Non-goals

- Migrating other still-ignored majors (`vitest`, `typescript`, `react`, Hardhat ecosystem, …).
- Adding `apps/jinn-agent` to the Dependabot allowlist.
- Changing wallet strength, HD path, or keystore encryption format.
- Committing or publishing from the Design stage (coordinator owns lifecycle).

## 8. Spec self-review

- No TBD/TODO left for the three residuals.
- Execute vs defer is explicit per dep; legacy lucide scope is explicit.
- Dependabot remove-vs-retarget rule matches AC4 for landed majors.
- Scope fits one chore PR; no product design ambiguity remaining.
