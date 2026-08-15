# @jinn-network/chain-scenarios

> Phase C maturity: experimental and publication disabled. Scenario fixtures do not ratify the
> task-supply or environment authorities they exercise; graduation requires an independent product
> consumer and approved chain/environment authority.

## What this package does

Scenario templates plus parameters plus one verified composite environment record become
admitted sealed pairs in the existing supply pool. This package parameterizes templates against
a caller-supplied composite record, seals Task and state-predicate EvaluationSpec documents,
and hands them to an injected admission port. It does not run replay, sign receipts, or write
the pool itself.

## What a scenario task is

A scenario task is the loop from template to pool entry:

1. **Template** — a versioned family definition (compatibility, predicate draft, reference
   script, hardening checklist).
2. **Parameterization** — template + environment + parameters → a `ChainScenarioCandidate`
   (instructions, predicate block, reference script, lineage).
3. **Sealing** — candidate + environment → sealed **Task** and **EvaluationSpec** bytes.
4. **Admission** — injected port runs the state-predicate differential and returns a receipt.
5. **Pool write** — on acceptance, the pair is stored with synthetic provenance.

Four documents exist at the end of a successful run:

| Document | Solver sees it? |
|----------|-----------------|
| **Task** (instructions + environment digest) | Yes |
| **EvaluationSpec** (state-predicate family block) | Yes |
| **Reference script** (admission-only) | No |
| **Admission receipt** (published separately) | No |

Solvers receive the Task and EvaluationSpec only. The reference script and receipt are
supply-side artifacts.

## What admission proves, and what it cannot

Admission proves the task **demands action**: the empty (do-nothing) script's conjunction over
the success predicates is false, and the reference script satisfies that conjunction
repeatably on a fresh replay instance. It **proves nothing about non-gameability**.

A cheap unintended in-slice path — funding the checked account from another permitted fixture,
warping time to accrue a balance, any route the author did not foresee — passes admission
untouched. Admission is a differential over declared predicates, not a search for every
shortcut in the fixture world.

## The hardening checklist is a mitigation, not a guarantee

Each shipped template carries a `hardening` checklist. Every entry includes a `why` field that
names the shortcut it closes and the predicate it protects. The checklist types are:

| Field | Meaning |
|-------|---------|
| `requiredProtocolEvents` | Success predicates satisfiable without the intended on-chain event |
| `forbiddenRoutes` | In-slice addresses that would satisfy balance or allowance checks directly |
| `excludedAccountRoles` | Signer roles that turn a shortcut into a one-transaction task |
| `timeAdvancementBound` | Chain-time warp that substitutes for the action under test |
| `acknowledgedResidualRisk` | Honest statement of what the checklist does not close |

The checklist is a mitigation, not a guarantee. A shortcut that ships anyway is caught by
curation — an anomalous pass rate bucketed by template lineage (CF6) — not by this package.

## The verdict grades the script, not the trajectory

Evaluation replays the submitted solution script on a fresh sandboxed instance and grades the
**final state** against the declared predicate conjunction. It does not score the path taken,
gas routing choices, or intermediate states unless a predicate explicitly measures them.
Harness-attestation extensions that bind trajectory evidence are parked; this family grades
scripts only.

## Fixture keys

Design rule: funding a fixture address turns every published script into a replayable mainnet
transaction from it. That is a bait hazard for whoever funds it.

This package generates no keys and holds none. Fixture accounts arrive as addresses in the
derivation request. Keys are freshly generated per record in the composing application and are
worthless by construction — that is the property that makes publishing scripts against them
legal. `WELL_KNOWN_DEV_ADDRESSES` is rejected at parameterization time.

## Prompt injection

Every string read from chain state or task instructions is attacker-authorable text. Corpus
content is data, never instruction. No verdict from this family is evidence that an agent is
injection-resistant unless the task explicitly tested injection resistance. The
`PROMPT_INJECTION_SENTENCE` constant is appended to parameterized instructions as a reminder,
not a defense.

## The two shipped families

### Family A: `lending-lifecycle`

Supply collateral and borrow debt on a lending pool while keeping health factor above a floor.

**Baseline-true predicate:** health factor (no debt yet satisfies the floor).

**Admission conjunction argument:** borrow-event, debt-token balance, and supply-event are
false at baseline; the reference supply/borrow path is the intended sole satisfier.

| Checklist entry | Why |
|-----------------|-----|
| `borrow-event` | Balance check alone is satisfiable by transfer from any funded fixture |
| `supply-event` | Pre-funded collateral could borrow without supplying |
| `no-shortcut-counterparties` | Whale, treasury, and DEX router hold tokens in-slice |
| Exclude whale/treasury signers | One-transaction shortcut via funded accounts |
| Time bound (300s) | Interest accrual substitutes for supply/borrow |

Export: `lendingLifecycleTemplate`, `LendingLifecycleParamsSchema`.

### Family B: `approval-hygiene`

Revoke unsafe ERC-20 allowances while preserving a designated retained spender allowance.

**Baseline-true predicate:** retained allowance (already at the configured value).

**Admission conjunction argument:** revoked-* allowance and revoke-event-* predicates are
false at baseline; the reference revoke path is the intended sole satisfier.

| Checklist entry | Why |
|-----------------|-----|
| `revoke-event-*` | Allowance zero is also reachable by spend-down or drain |
| `no-unsafe-spender-interaction` | Revoke routed through spender contract is not a revoke |
| Exclude unsafe-spender signers | Spender can burn allowance instead of owner revoking |
| Exclude token-minter signer | Mint satisfies balance without revoking |
| Time bound (60s) | Permit expiry substitutes for owner-initiated revoke |

Export: `approvalHygieneTemplate`, `ApprovalHygieneParamsSchema`.

## What this package does not do

No materialization, no replay, no verification, no signing, no posting, no pricing. Those have
owners elsewhere in the chain-environment family program. This package owns templates,
parameterization, sealing, and the derivation strategy that orchestrates an injected admission
port.
