---
title: OLAS Protocol On-chain Architecture
purpose: context
scope: [deployment]
last_verified: 2026-01-30
related_code:
  - worker/delivery/transaction.ts
keywords: [olas, autonolas, tokenomics, governance, veOLAS, staking, registry, treasury]
when_to_read: "When understanding OLAS governance, tokenomics, registries, or on-chain contracts"
---

Olas (Autonolas) — On-chain Architecture (Economics & Smart Contracts)

Scope: Purely on-chain. Governance, tokenomics, registries, staking, bridges. Nothing about off-chain agents, frameworks, or apps.

⸻

Snapshot (TL;DR)

Three pillars:
	1.	Governance: OLAS (ERC-20) + veOLAS (vote-escrow), Governor, Timelock, and wrappers (wveOLAS, buOLAS legacy). This governs parameters, emissions, staking weights, upgrades.  ￼ ￼
	2.	Registries: ERC-721 registries for Components, Agents, Services plus managers (e.g., RegistriesManager, ServiceManager). They mint and track canonical code artefacts and service state.  ￼
	3.	Tokenomics: Treasury, Depository (bonding), Dispenser (claims), Tokenomics (emissions schedule & accounting). Donations in ETH (or native) and on-chain KPIs feed mint limits for top-ups and bonds.  ￼ ￼

Deployments (high-level):
Canonical L1 is Ethereum (OLAS, veOLAS, Governor, Timelock, Tokenomics, Treasury/Depository/Dispenser). L2s (Polygon, Gnosis, Optimism, etc.) host light registries and staking targets; cross-chain sync uses per-chain DepositProcessor (L1) ↔ TargetDispenser (L2) adaptors.  ￼ ￼ ￼

⸻

Governance

Tokens
	•	OLAS (ERC-20): Canonical token on Ethereum: 0x0001A500A6B18995B03F44bb040A5fFc28E45CB0.  ￼
	•	veOLAS (vote-escrow): Lock OLAS for time-weighted voting; MAXTIME = 4 years (linear decay). Address: 0x7e01A500805f8A52Fad229b3015AD130A332B7b3.  ￼
	•	Wrappers / legacy: wveOLAS and burnable-locked buOLAS (legacy team incentive). (Addresses below.)  ￼

Governor & Timelock
	•	GovernorOLAS (governance) + Timelock (execution delay) follow the OpenZeppelin model; veOLAS holders govern. Cross-chain execution uses per-L2 tunnels/mediators.  ￼

Staking governance weights
	•	VoteWeighting contract (Curve-style gauge controller) lets veOLAS holders assign emissions across staking programmes (gauges). Anyone can add staking contracts; DAO controls the Dispenser and parameters.  ￼ ￼

⸻

Registries (ERC-721)

What they track
	•	ComponentRegistry → reusable components
	•	AgentRegistry → canonical agents built from components
	•	ServiceRegistry → multi-operator services (states: Pre-Registration → Active → Finished → Deployed → Terminated Bonded).  ￼

Managers / helpers
	•	RegistriesManager, ServiceManager, ServiceRegistryTokenUtility, StakingVerifier/Factory handle lifecycle, bonding deposits, and staking-related verification; L2s host light versions optimised for staking.  ￼

⸻

Tokenomics (inflation, bonding, donations, claims)

Supply policy (core)
	•	Epoch-based emissions: first 10 years capped to reach 1bn OLAS, then up to 2% annual thereafter; Tokenomics contract enforces annual mint caps and splits across bonds and top-ups. (Deployed behind a proxy for upgradability.)  ￼ ￼

Modules
	•	Treasury: Holds ETH & whitelisted tokens; receives service donations; pays out ETH rewards and mints OLAS top-ups under Tokenomics limits. Address below.  ￼
	•	Depository (Bonding): Accepts approved LP tokens to purchase vested OLAS at a discount; DAO sets discount and token whitelist; mints subject to annual cap.  ￼ ￼
	•	Dispenser (Claims): Aggregates rewards/top-ups for claim by eligible NFT holders (components/agents) and by staking programme operators, once proofs/weights are finalised. (Also runs per-L2 TargetDispensers).  ￼
	•	Tokenomics (controller): Owns the schedule, tracks donations, calculates per-epoch splits (treasury share, developers’ top-ups, staking emissions), and coordinates managers’ calls. (Proxy + implementation).  ￼

⸻

Cross-chain design (governance & staking emissions)
	•	Governance messages: L1 Governor/Timelock → per-chain tunnels (e.g., FxGovernorTunnel on Polygon; HomeMediator on Gnosis). These forward parameter changes and nominees/gauge adds to L2.  ￼
	•	Emissions sync: At each epoch, L1 DepositProcessor pushes data to L2 TargetDispenser; L2 staking contracts reference the latest epoch weights from VoteWeighting to allow programme operators to claim OLAS on the target chain.  ￼

⸻

Addresses (Ethereum mainnet unless stated)

Always verify in the official docs/apps before interacting. The Olas team notes the “Autonolas Deployer” address on Etherscan has no privileged role; control sits with veOLAS governance.  ￼

Governance
	•	OLAS (ERC-20): 0x0001A500A6B18995B03f44bb040A5fFc28E45CB0 (ETH L1).  ￼
	•	veOLAS (vote-escrow): 0x7e01A500805f8A52Fad229b3015AD130A332B7b3.  ￼
	•	GovernorOLAS: 0x8e84b5055492901988b831817e4ace5275a3b401. Timelock: 0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE.  ￼
	•	wveOLAS: 0x4039B809E0C0Ad04F6Fc880193366b251dDf4B40. buOLAS (legacy): 0xb09CcF0Dbf0C178806Aaee28956c74bd66d21f73.  ￼
	•	Cross-chain tunnels: Polygon FxGovernorTunnel 0x9338b5153AE39BB89f50468E608eD9d764B755fD; Gnosis HomeMediator 0x15bd56669F57192a97dF41A2aa8f4403e9491776.  ￼

Tokenomics (selected)
	•	Tokenomics (Proxy): 0x87f89F94033305791B6269AE2F9cF4e09983E56e (manages Treasury/Depository/Dispenser refs).  ￼
	•	Treasury: 0xA0dA53447C0F6C4987964D8463Da7E6628B30f82.  ￼
	•	(Depository / Dispenser have seen iterations; confirm current addresses in the app/docs before use.)  ￼

Registries / L2 (examples)
	•	Docs index of on-chain addresses (per network, including Service Registry L2 & ServiceManager): see “On-chain addresses” and chain profiles.  ￼ ￼

⸻

How money and votes actually flow

A) Donations → Developer rewards/top-ups

User / Integrator
     │ donates ETH (or native)
     ▼
ServiceRegistry / Treasury      (accounting of donations)
     │ periodic epoch close via Tokenomics
     ▼
Tokenomics computes:
  - Treasury cut (ETH)
  - Developer rewards (ETH, if any)
  - Developer top-ups (OLAS mint, within annual cap)
     │
     └──► Dispenser (per-account accruals)
             │
             └──► Component/Agent NFT owners claim (ETH / OLAS)

Design: ETH donations accumulated; OLAS top-ups minted under the annual cap enforced by Tokenomics/Treasury/Dispenser trio.  ￼

B) Bonding (Depository) and mint limits

LP providers (whitelisted LP tokens)
     │ deposit LP → buy OLAS at discount (with vesting)
     ▼
Depository ──► Treasury (reserves)
     │
     └──► Tokenomics checks annual cap; issues vested OLAS

DAO tunes discount/vesting; minting for bonds + top-ups must remain within yearly issuance budget.  ￼ ￼

C) Cross-chain staking emissions (L1→L2)

veOLAS voters                   (on Ethereum)
     │ set weights per staking programme (VoteWeighting)
     ▼
Tokenomics computes epoch emissions
     │
DepositProcessor (L1) ──bridge──► TargetDispenser (L2)
                                        │
                                        └──► Staking programme contracts let operators claim OLAS on L2

Bridges use per-chain processors/dispensers audited in Immunefi scope.  ￼

⸻

Governance surfaces you’ll actually touch
	•	Weights & staking: Assign weights to staking programmes (gauges) via VoteWeighting → changes where OLAS emissions go each epoch.  ￼
	•	Parameters: Quorum, proposal thresholds, caps, lists; execution guarded by Timelock; upgrades via proxies where applicable.  ￼
	•	Cross-chain: Tunnels/mediators propagate allowlists and programme adds to L2s; verify target addresses per chain.  ￼

⸻

Audits, security, provenance
	•	C4 (Code4rena) competitions & findings (governance, staking, registries).  ￼ ￼
	•	SourceHat audits (governance & tokenomics modules w/ addresses).  ￼
	•	Immunefi bug bounty (lists deposit processors & target dispensers per chain).  ￼

⸻

Practical notes
	•	Where to double-check addresses:
	1.	OLAS site → Token page (per-chain token addresses); 2) Docs → On-chain addresses; 3) Govern app (staking contracts, programmes).  ￼ ￼
	•	Deployer myth: The “Autonolas Deployer” label on Etherscan confers no special powers; the DAO (veOLAS) controls the protocol.  ￼

⸻

Disclosure & influence considerations (re: Jinn)

Disclosure: The founders of the Jinn project are also founding members of the Olas DAO.
What that can mean for influence:
	•	Voting power: If those founders lock material OLAS into veOLAS, they can affect staking weight allocations (via VoteWeighting) and parameter proposals subject to quorum/thresholds. Influence is transparent and proportional to veOLAS.  ￼
	•	Social & technical sway: Founding-member status (Olas DAO founded in 2022 with ~50 participants) often correlates with outsized context and reputation, which can shape off-chain discussion and on-chain agenda-setting. Formal power still routes through Governor/Timelock.  ￼ ￼
	•	Checks & balances: Timelock delays, public voting, proxy-based upgrades, and audit/bounty processes reduce unilateral control. Cross-chain sync is adapter-gated and auditable.  ￼ ￼

⸻

Appendices

A) Canonical contract addresses (ETH L1)

Module	Address
OLAS	0x0001A500A6B18995B03f44bb040A5fFc28E45CB0
veOLAS	0x7e01A500805f8A52Fad229b3015AD130A332B7b3
GovernorOLAS	0x8e84b5055492901988b831817e4ace5275a3b401
Timelock	0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE
wveOLAS	0x4039B809E0C0Ad04F6Fc880193366b251dDf4B40
buOLAS (legacy)	0xb09CcF0Dbf0C178806Aaee28956c74bd66d21f73
Tokenomics (Proxy)	0x87f89F94033305791B6269AE2F9cF4e09983E56e
Treasury	0xA0dA53447C0F6C4987964D8463Da7E6628B30f82
Cross-chain tunnels (examples)	Polygon FxGovernorTunnel 0x9338…755fD; Gnosis HomeMediator 0x15bd…1776

Sources: Etherscan & SourceHat audit address lists.  ￼ ￼

B) Where to find per-chain registry/staking addresses
	•	Docs → On-chain addresses (ServiceRegistry / ServiceManager / TokenUtility).
	•	Govern app (staking contracts & programme pages).  ￼ ￼

⸻

C) Call/flow diagrams (text)

C1. Governance change (L1) → parameter on L2

veOLAS voters → GovernorOLAS → Timelock
   │ proposal/queue/execute
   ▼
Bridge adaptor (e.g., FxGovernorTunnel / HomeMediator)
   │ message
   ▼
Target chain registry/staking contract
   (param updated)

￼

C2. Staking epoch settlement

VoteWeighting (weights) ─► Tokenomics (emissions calc)
       │                           │
       └───────── L1 DepositProcessor ──bridge──► L2 TargetDispenser
                                           │
                                           └─► StakingProgramme.claim()

￼ ￼

⸻

Notes on certainty
	•	Exact Depository/Dispenser addresses can rotate via governance; confirm in the docs/app before using.  ￼
	•	L2 staking targets and service registries are per-chain; use the On-chain addresses page and Govern app.  ￼ ￼

