# @jinn-network/chain-scenarios

Scenario templates and parameterization that turn a verified composite crypto environment
record plus parameters into admitted, sealed Task and state-predicate EvaluationSpec pairs
in a supply pool.

## Scenario families

### `lending-lifecycle` (Family A)

Supply collateral and borrow debt on a lending pool while keeping health factor above a
configured floor. Admission checks the **conjunction** of success predicates: health factor
is already satisfied at baseline (no debt), but borrow-event and debt-token balance are not,
so the task demands the reference supply/borrow path. Hardening requires pool `Borrow` and
`Supply` events, forbids whale/treasury/DEX shortcut counterparties, bounds chain-time
advancement, and excludes treasury/whale signer roles.

Export: `lendingLifecycleTemplate`, `LendingLifecycleParamsSchema`.

### `approval-hygiene` (Family B)

Revoke unsafe ERC-20 allowances while preserving a designated retained spender allowance.
Admission checks the **conjunction**: the retained allowance is already satisfied at baseline,
but revoked-* and revoke-event-* predicates are not, so the task demands selective revocation.
Hardening requires owner-initiated `Approval(owner, spender, 0)` events per unsafe spender,
forbids routing through unsafe spender contracts, bounds chain-time advancement, and excludes
unsafe-spender and token-minter signer roles.

Export: `approvalHygieneTemplate`, `ApprovalHygieneParamsSchema`.
