# Substrate test fixtures

These are *not real* operator state. All addresses are placeholders (0x1111...,
0x2222...). They exist purely for unit tests of substrate-adopt, substrate-copy,
and substrate-verify. The on-chain identity referenced here does not exist on
any real chain; tests that exercise on-chain reads must use the Anvil fork
helper (`helpers/anvil-fork.ts`) to seed deterministic state.

Two fixtures:
- `op-a-fixture/` — launcher role, agentId 99001
- `op-b-fixture/` — participant role, agentId 99002
