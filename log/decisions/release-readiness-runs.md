# release-readiness audit trail

One line per release-readiness run. Format: `timestamp | version | mode | recommendation=<X> | handoff=<path>`.

2026-05-23T00:00:00Z | v2026.05.25 | human-invoked | recommendation=SHIP | handoff=docs/release/v2026.05.25/handoff.md
2026-05-23T17:37:02Z | v2026.05.25 | human-invoked-revalidate | recommendation=SHIP | handoff=docs/release/v2026.05.25/handoff.md | branch-tip=77e79635 | tier-3-task-id=218 | tier-3-verdict-tx=0xede5949c5a1d6ba732d32b803d0568d8f5c67488cbd3838d9c8c605c2af184df | notes=mainline-solvernet,fallback-default-off,indexer-restored

2026-05-30T00:00:00Z | v0.1.8 | human-invoked | recommendation=SHIP | handoff=docs/release/v0.1.8/handoff.md | branch=release/v0.1.8 | branch-sha=fcd02cf7 | tier-3-loop=PROVEN (verdictCode=1 on-chain, isolated tasks 1552 & 1559) | tier-3-marker=flaked-infra | notes=5-fixes(nonce/getLogs-retry/isolated-net/rpc-fallback/staking-decouple),isolated-substrate,docker-4gib-oom

2026-06-08T10:35:00Z | v0.1.8 (release/v0.1.8-6171e3a8) | paired-flow-gate-PRACTICE (DR-2026-06-08) | recommendation=PASS | runbook=.claude/skills/testing-jinn-app/references/scenario-multi-op-spa-flow.md | ops=op-b(svc56/agent5941 launcher)+op-c(svc65 evaluator) | launch-cid=bafkreicewlyydd4vh76bitww5mnftoggorp5s32owpoy5ydzrig22npwmy | launch-tx=0x3b4bde71db548e5e78d2f31a4cc4c1ee4bbb2588dbfedb1db698c3d5a994f956 | notes=first dogfood of the soft gate; op-b create→launch LAUNCHED + op-c discover-by-CID→IPFS-manifest→join-as-evaluator OK; paper-cut: transient "Daemon offline" banner on op-c right after JOIN POST (cosmetic — daemon was up HTTP 401, proc alive), NOT product-red
