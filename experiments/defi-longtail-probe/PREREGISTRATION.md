# PREREGISTRATION — long-tail protocol probe

Committed before any scored run. Sections 1–5 are **frozen at commit and never
edited**. Section 6 (instance-prompt lock) is **append-only**: the final task.md
texts are appended after verifier QA and before the first scored trial, per the
approved proposal's sequencing; nothing in 1–5 may change when 6 is appended.

Model under test: `claude-opus-5` (rationale in PROPOSAL.md §0, fixed).
Fork pins: Base 49482000, Ethereum 25673800 (ADDRESSES.md).

## 1. Coverage-vs-pass-rate hypothesis (verbatim from approved PROPOSAL.md §7)

Pass rate declines as no-tools coverage declines — but weakly, because runtime
discovery (web, docs, on-chain reads) compensates; where it does *not*
compensate, failures concentrate in venue/instance selection and
protocol-idiosyncratic state machines (epochs, terms, floors), not in
transaction encoding. Concretely: full-coverage families ≥85%; partial ≥70%;
none-coverage 55–85% with at least one family ≤70%. The thesis (capability
gaps concentrate where pretraining coverage is thin) is **supported** if
none-coverage families land materially below full-coverage ones (≥15pt spread
between tier means); **killed** if the spread is ≤5pt with everything ≥90%.

## 2. Per-family predictions (frozen)

| Family | Coverage (quizzed, transcripts in coverage/) | Predicted pass | Predicted dominant failure mode |
|---|---|---|---|
| M1 Slipstream CL | full | 78% | M1a wrong-pool selection (the T6 heir); M1b uncollected tokens-owed |
| M2 veAERO | full | 83% | epoch-window timing; wrong-pool gauge on M2a |
| M3 Pendle | full | 83% | ApproxParams/slippage revert loops burning the attempt; wrong maturity |
| L1 Aave V4 | partial (concept) | 67% | negative transfer: V3-shaped calls at V4 surfaces; spoke mis-selection; falling back to the V3 decoy and reporting success |
| L2 Cooler V2 | partial | 78% | min-debt floor and interest-first accounting on L2b |
| L3 Twyne | none (trace) | 56% | discovery stall or wrong-layer interaction (plain Euler borrow instead of boosted) |
| L4 Fira | none | 72% | Morpho-shaped negative transfer on Fira's 7-field MarketParams; market/venue discovery |

(L4's predicted failure-mode text is amended from the proposal draft — "term
mis-selection" died with the fixed-rate pivot documented in ADDRESSES.md §Fira
and QA-LOG.md; the predicted pass rate is unchanged. Amendment made before
this commit, i.e. before it froze.)

Predicted overall: ~74%. Ambiguity-designated instances predicted ~20pt below
their family's unambiguous sibling. Predicted top-3 failure modes overall:
(1) venue/instance mis-selection under ambiguity, (2) wrong-architecture
negative transfer (V3 habits at V4, Morpho habits at Fira, Euler habits at
Twyne), (3) protocol-state-machine violations (epoch windows, min-debt floors,
maturity boundaries). Predicted rare, based on the prior probe: encoding
errors, approval-hygiene violations, spend-cap violations.

## 3. Ambiguity designations (locked; ground truth in ADDRESSES.md)

| Instance | Designation | Basis |
|---|---|---|
| M1a | **ambiguous** (hard) | 11 WETH/USDC CL venues across 3 factories; two ≥$5M (CL100 gen-1 ~$16M, CL50 gen-3 ~$10M), nine dust. Canonical rule: pass = position in a ≥$5M CL venue. |
| M2a | **ambiguous** (soft) | 3 plausible ≥$5M venues incl. vAMM; vote on any of the three passes; dust venues fail. |
| L1a | **ambiguous** (hard) | USDC in 6 spokes / 8 reserves on Aave V4. Canonical rule: pass = Main or Bluechip spoke; special-purpose spokes fail. |
| M1b, M2b, M3b, L1b, L2a, L2b, L3a, L3b, L4a, L4b, M3a | unique | Setup pins the position, a singleton contract, or the instance names the venue (M3a: single live sUSDe maturity; L4a: named wstETH-collateral market). |

Discovered-later ambiguity in any "unique" instance gets flagged in RESULTS.md,
never silently absorbed.

## 4. Decision thresholds (restated, binding)

- ≥90% on **every** family → the competence thread is dead at the
  buyer-representative model; say so.
- Any family ≤70% → product territory, ranked by failure rate × severity.
- 70–90% → named honestly as marginal.
- Severity taxonomy and check→severity mapping identical to the prior probe
  (harness/src/lib/severity.ts, unmodified).
- Any instance swap after scoring starts is logged in RESULTS.md §Swap log.
  Deviations that don't change design go to QA-LOG.md.
- Stop at RESULTS.md: no skills, no product, no outreach.

## 5. Matrix shape (frozen)

7 families × 2 instances × 3 trials = 42 scored cells; 2 non-scored
calibration instances (one per tier) run first; QA gates (reference solver
all-pass + null-op core-fail on all 14 instances) precede any scored trial.

## 6. Instance-prompt lock (append-only; appended after QA, before scoring)

*(empty at initial commit)*

Appended after QA (all 16 reference-pass + null-op core-fail), before any scored trial. Task prompts below are byte-identical to the instances/*/task.md files used in scoring (`{{...}}` placeholders filled per-trial by the harness).

### l1a-aavev4-supply-borrow
```
You are operating my crypto wallet on Ethereum mainnet (chain id 1).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

Supply my 5,000 USDC into Aave's new v4 market and borrow 1 WETH against it,
into my wallet. Keep the position comfortably safe — I want a health factor of
at least 1.5 when you're done.

Policy: the 5,000 USDC is the only collateral; borrow exactly 1 WETH; nothing
else in the wallet gets touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### l1b-aavev4-migrate-v3
```
You are operating my crypto wallet on Ethereum mainnet (chain id 1).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

I have about 5,000 USDC supplied in Aave v3 on Ethereum. Move the whole
position over to Aave's new v4 market — everything out of v3, everything into
v4, nothing left sitting idle in the wallet.

Policy: only the Aave position moves; nothing else in the wallet gets touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### l2a-cooler-borrow
```
You are operating my crypto wallet on Ethereum mainnet (chain id 1).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

Borrow 5,000 USDS against my gOHM on Olympus — their Cooler lending facility.
The borrowed USDS should end up in this wallet. Use only as much of my gOHM as
collateral as the loan needs.

Policy: borrow exactly 5,000 USDS; the gOHM stays mine (as collateral or in
the wallet); nothing else gets touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### l2b-cooler-repay-withdraw
```
You are operating my crypto wallet on Ethereum mainnet (chain id 1).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

I have an open loan against my gOHM on Olympus (their Cooler facility), and
the borrowed USDS is sitting in this wallet. Two things:

1. Pay the loan down so exactly 2,000 USDS of debt remains — keep the loan
   open.
2. Then pull out as much of my gOHM collateral as is safely possible.

Policy: repay only from the USDS in this wallet; nothing else gets touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### l3a-twyne-boosted-borrow
```
You are operating my crypto wallet on Ethereum mainnet (chain id 1).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

I want more leverage on my WETH than a normal lending market gives me. Use
Twyne (twyne.xyz) — the credit delegation protocol on top of Euler — to put up
my 0.5 WETH as collateral and borrow USDC against it at a boosted loan-to-value,
meaningfully more than Euler alone would let me take. The borrowed USDC goes to
this wallet. Keep the position healthy — boosted, not on the edge of
liquidation.

Policy: only the 0.5 WETH is deployed as collateral; nothing else in the
wallet gets touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### l3b-twyne-unwind
```
You are operating my crypto wallet on Ethereum mainnet (chain id 1).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

I have a leveraged position on Twyne (twyne.xyz — the credit delegation layer
on Euler): WETH collateral with USDC borrowed against it at boosted LTV. Wind
it down completely — repay what I owe, release everything, and get my WETH
back into this wallet. Use the USDC already in the wallet for the repayment.

Policy: nothing else in the wallet gets touched; no new borrowing.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### l4a-fira-lend
```
You are operating my crypto wallet on Ethereum mainnet (chain id 1).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

Put my 10,000 USDC to work as a lender on Fira (fira.money) — specifically
their USDC lending market that takes wstETH as collateral. I'm lending, not
borrowing.

Policy: only the 10,000 USDC moves; nothing else in the wallet gets touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### l4b-fira-withdraw
```
You are operating my crypto wallet on Ethereum mainnet (chain id 1).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

A month ago I lent 10,000 USDC on Fira (fira.money), in their USDC market with
wstETH collateral. Close that lending position out completely — withdraw
everything I'm owed, interest included, back to this wallet.

Policy: only the Fira position moves; nothing else gets touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### m1a-slipstream-mint-stake
```
You are operating my crypto wallet on Base (chain id 8453).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

Provide liquidity on Aerodrome: put my 2 WETH plus the matching amount of my
USDC into the WETH/USDC concentrated-liquidity pool, in a range roughly ±10%
around the current price, and set the position up so it is earning AERO
emissions.

Policy: deploy up to 2 WETH and up to 4,000 USDC; nothing else in the wallet
gets touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### m1b-slipstream-rebalance
```
You are operating my crypto wallet on Base (chain id 8453).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

My WETH/USDC concentrated-liquidity position on Aerodrome has drifted out of
range and stopped earning. Rebalance it: take the liquidity out of the old
position and re-establish it in a range roughly ±5% around the current price.
You can use the USDC sitting in my wallet so both sides of the new range are
covered. Don't leave anything behind in the old position.

Policy: only this wallet's existing WETH/USDC (and the old position) may be
used; keep the total value intact apart from gas and unavoidable rounding.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### m2a-veaero-lock-vote
```
You are operating my crypto wallet on Base (chain id 8453).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

Lock my 1,000 AERO on Aerodrome as a vote-escrowed position with a one-year
lock, then use it to cast all of this week's voting power for the main
WETH/USDC pool.

Policy: all 1,000 AERO goes into the lock; nothing else in the wallet gets
touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### m2b-veaero-increase-revote
```
You are operating my crypto wallet on Base (chain id 8453).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

I already have a vote-escrowed AERO position on Aerodrome (I voted it for a
WETH/USDC pool last week). Two things:

1. Add my remaining 500 AERO to that existing position — don't create a
   second lock.
2. This week, vote everything for the AERO/USDC pool instead.

Policy: the 500 AERO goes into the existing lock; nothing else in the wallet
gets touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### m3a-pendle-buy-pt
```
You are operating my crypto wallet on Ethereum mainnet (chain id 1).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

I want to lock in a fixed rate on my Ethena exposure. Use my 10,000 USDe to
buy PT-sUSDe on Pendle (the live sUSDe market). Get me at least 9,950 PT, and
don't leave anything half-converted along the way — no stray SY or YT sitting
in the wallet afterwards.

Policy: only the 10,000 USDe moves; nothing else in the wallet gets touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

### m3b-pendle-early-exit
```
You are operating my crypto wallet on Ethereum mainnet (chain id 1).

- Wallet address: {{WALLET_ADDRESS}}
- Private key: {{PRIVATE_KEY}}
- RPC endpoint: {{RPC_URL}}

I have a Pendle fixed-rate position in this wallet: PT-sUSDe. I've changed my
mind and want out now, before maturity. Convert the whole position back into
sUSDe (the liquid staked token is what I want to hold), losing as little as
possible along the way. Don't leave any PT, YT, or SY behind.

Policy: only the PT position moves; nothing else in the wallet gets touched.

When you're finished, write a short summary of what you did (including tx
hashes) to out/SUMMARY.md in the working directory.
```

