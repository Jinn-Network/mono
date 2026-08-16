# Identity

Jinn uses one ERC-8004 agent identity per Safe. The bootstrap state machine completes that identity in two stages, each independently re-entrant. Spec reference: `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md` §5.1.

## Stage 1 — Identity (universal)

Required for any participation, builder or operator.

```
wallet → safe_predicted → awaiting_funding (ETH only) → safe_deployed → identity_registered
```

- **wallet** — derive a fresh agent EOA from your keystore.
- **safe_predicted** — deterministically predict the Safe address from the EOA.
- **awaiting_funding** — pause until the EOA has ETH for gas. **No OLAS required.**
- **safe_deployed** — deploy the Safe via the factory.
- **identity_registered** — mint the agent NFT via `IdentityRegistry.register()` and bind the Safe via `setAgentWallet`.

After Stage 1 you have a full ERC-8004 identity and can sign `setMetadata` for any kind (envelope, evaluation, capture, intent, plugin, revocation). You can publish plug-ins. You cannot yet claim and deliver tasks as an operator.

## Stage 2 — Operator (opt-in)

Required only for users who want to run a daemon and earn from tasks.

In standard (stOLAS) mode:

```
awaiting_stake → staked → mech_deployed
```

In self-bond mode (legacy):

```
service_created → service_activated → agents_registered → service_deployed → service_staked → mech_deployed
```

Stage 2 requires OLAS for the service bond. In standard mode, Stage 2 creates a separate staking Safe; in self-bond mode, Stage 2 reuses the Stage 1 Safe.

## Lazy stage-ensure per action

| Action | Ensures stage |
|---|---|
| `jinn solver-plugins publish` | Stage 1 |
| `jinn solver-plugins revoke` | Stage 1 |
| `jinn run` (operator daemon) | Stage 1 + 2 |

A builder who later wants to operate runs `jinn run`. The state machine detects Stage 1 done and continues at the first Stage 2 step. No re-mint, no second agentId on the same Safe by default. The `--new-agent-id` flag is an opt-in escape hatch for users who want explicit reputation-stream separation.

## One agentId, multiple streams

A dual-role user (operator-also-builder) is the natural case. The Ponder indexer separates streams by metadata `kind`:

- Operator activity flows through `envelope:` / `evaluation:` / `capture:` keys.
- Builder activity flows through `plugin:` / `revocation:` keys.

Both reference the same `agentId`.
