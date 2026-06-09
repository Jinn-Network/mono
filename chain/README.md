# chain

A local, single-node Cosmos EVM devnet whose native coin is **JINN** — the token
used for gas, staking, and value on the chain. Use this directory to stand the
chain up locally and verify it works.

## Requirements

`go`, `make`, `jq`, `git`, and Foundry (`cast`) on your PATH. The governance and
loop checks additionally need Node 22 with `corepack yarn install` run once in
`../contracts`.

## Usage

```bash
cd chain
./up.sh        # build the node on first run, then start it (EVM JSON-RPC on :8545)
./check.sh     # verify the chain is live and JINN is its native coin
./rung2.sh     # verify JINN can be locked for governance
./rung3.sh     # verify the work loop end to end: lock → vote → record work
./rung4.sh     # verify JINN secures consensus (staking)
./down.sh      # stop the node
```

Run them in order. The first `./up.sh` compiles the node from source (a few
minutes, cached afterwards). `./rung4.sh` re-initialises a fresh chain, so run it
last. `FRESH=1 ./up.sh` resets chain state. Each check exits `0` on success.

## Layout

| Path | Purpose |
|---|---|
| `up.sh` / `down.sh` | start / stop the node |
| `check.sh`, `rung2.sh`, `rung3.sh`, `rung4.sh` | verification checks |
| `lib.sh` | shared configuration |
| `.build/` | node source, binary, and chain data (not committed) |
