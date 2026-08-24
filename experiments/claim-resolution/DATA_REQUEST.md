# Data request: genuine historically-disputed oracle cases

**Purpose.** Build a benchmark of claims that generated *real-world* disagreement, to test
whether a multi-solver network resolves them more accurately than one strong web-enabled
agent. The previous benchmark was agent-curated and ceilinged at 100%; ground truth for
this one must come exclusively from a protocol's own historical resolution record, with no
model involved in deciding what the correct answer was.

**Status.** The experiment is blocked. Every route to protocol data is refused by this
environment's egress policy (see §0). Nothing was substituted.

---

## 0. Read this first — the cheap fix may not need anyone else

Before sending any of this to the Reality.eth or Kleros teams, check whether the block can
simply be lifted. This environment refuses outbound HTTPS to every relevant host with a
`403` on `CONNECT` (organizational egress policy, confirmed via the agent proxy's own
failure log on 2026-08-19):

```
rpc.ankr.com · cloudflare-eth.com · ethereum.publicnode.com · eth.llamarpc.com
rpc.gnosischain.com · gnosis.publicnode.com · rpc.gnosis.gateway.fm
polygon-rpc.com · polygon.publicnode.com
api.thegraph.com · gateway.thegraph.com · gateway-arbitrum.network.thegraph.com
api.etherscan.io · api.gnosisscan.io
reality.eth.limo · reality.eth.link · realitio.github.io
gamma-api.polymarket.com · clob.polymarket.com · api.uma.xyz · oracle.uma.xyz
ipfs.io · gateway.pinata.cloud · cloudflare-ipfs.com
archive.org · web.archive.org · huggingface.co
```

Only `github.com` / `raw.githubusercontent.com`, `registry.npmjs.org` and `pypi.org` are
reachable. Those carry subgraph *source code* but not indexed data, so they do not help.

**Allowlisting any one of the following would unblock the whole experiment with no
third-party involvement:**

| priority | host | what it gives us | cost |
|---|---|---|---|
| 1 | one Ethereum **and** one Gnosis Chain JSON-RPC endpoint (archive-capable preferred) | everything in §1 read directly from contract logs — the most authentic possible ground truth, no intermediary | free public endpoints exist |
| 2 | `gateway.thegraph.com` (+ a Graph API key) | same data pre-indexed, far fewer requests | Graph query fees, small |
| 3 | `ipfs.io` or any IPFS gateway | Kleros evidence documents (§2), which are IPFS-addressed | free |
| 4 | `gamma-api.polymarket.com` | §3 UMA/Polymarket market text and resolution | free |

Priority 1 is sufficient on its own for the primary dataset. `eth_getLogs` over the
contracts in §1.1 reconstructs the full question and bond history without trusting anyone.

Send §1–§3 to the protocol teams only if allowlisting is not possible.

---

## 1. Reality.eth — primary source (preferred)

### 1.1 Scope

All questions on these deployments, from the deployment block to a stated snapshot block:

| chain | token | contract | address | first block |
|---|---|---|---|---|
| 1 (mainnet) | ETH | RealityETH-2.0 | `0x325a2e0F3CCA2ddbaeBB4DfC38Df8D19ca165b47` | 6531265 |
| 1 | ETH | RealityETH-3.0 | `0x5b7dD1E86623548AF054A4985F7fc8Ccbb554E2c` | 13194676 |
| 1 | ETH | RealityETH-3.2 | `0x6a2155613b68eFB38D5c6074921F3F4281c8c177` | 22100226 |
| 100 (gnosis) | XDAI | RealityETH-2.1 | `0x79e32aE03fb27B07C89c0c568F80287C01ca2E57` | 14005802 |
| 100 | XDAI | RealityETH-3.0 | `0xE78996A233895bE74a66F451f1019cA9734205cc` | 17997262 |
| 100 | XDAI | RealityETH-3.2 | `0xEb51d9d9717906c981C57af09C4a3449eF30705b` | 39142627 |
| 137 (polygon) | MATIC | RealityETH-2.1 | `0xA75AE6D61Dd9d55e8153A393E2fc859c6a0FC716` | 15610082 |
| 137 | MATIC | RealityETH-3.0 | `0x60573B8DcE539aE5bF9aD7932310668997ef0428` | 18901674 |

(Addresses taken from `@reality.eth/contracts@3.2.25`, `chains/deployments/`. ERC20 variants
welcome but lower priority. The mainnet subgraph deployment is
`QmaugeofXNk2tCN3U3LaEi8vRq99zZ6pbKYJDWbbVF1Z9E` if exporting from The Graph is easier.)

### 1.2 Mechanical selection filter — please apply exactly this, and nothing else

Include a question if it is **finalized** (`LogFinalize` emitted) **and** at least one of:

- **(a) contested bonding** — two or more `LogNewAnswer` events carrying *distinct* `answer`
  values (commit-reveal counted via `LogAnswerReveal`); or
- **(b) arbitration** — `LogNotifyOfArbitrationRequest` was emitted, whether or not it was
  later cancelled.

Please do **not** curate beyond this. Do not drop questions you consider uninteresting,
low-value, joke questions, or wrongly resolved. We apply our own topic exclusions
(sports fixtures, price lookups, trivial election counts) downstream and need to see what
we excluded. If the filter yields thousands of rows, send all of them — we need 50–200
*after* topic filtering and expect to discard most.

**If you have to prioritise, prioritise boolean questions** (`"type": "bool"`).
Our scoring compares a YES / NO / abstain answer against the protocol's finalized
value, so boolean questions score exactly. Single-select, uint and datetime cases
are still welcome and we will hold them for a secondary set, but they need an
answer-matching rule we have not built yet.

### 1.3 Fields, per question

Field names below are the contract's own (`RealityETH-3.0` ABI). Preserve raw on-chain
values; do not decode, normalise, translate or summarise anything.

**Identity and text**
- `chain_id`, `contract_address`, `contract_version`
- `question_id` (bytes32, hex)
- `template_id`, **and `template_text`** — the template's own format string (from
  `LogNewTemplate`, or the built-in for low ids). Please include this on every row.
  It is not redundant: template id semantics *changed* between contract versions —
  in `templates.json` (pre-3.2) field 2 of the bool template is `category`, while in
  `templates_3.2.json` it is `description` — and any id ≥ 6 is a custom template we
  cannot decode without its text. Our ingester parses the `%s` placeholders out of
  this string rather than assuming an id-to-field mapping, so a missing
  `template_text` sends the row to manual review instead of being silently mis-split.
- `question` — the **raw delimiter-separated string exactly as emitted by
  `LogNewQuestion`**, unsplit and unescaped. This is critical: the title, description,
  category, language and (for select types) the outcome list all live inside it, and any
  reformatting risks changing what the question asked.
- `content_hash`, `nonce`, `created`, `opening_ts`, `timeout`
- `user` (asker), creation `block_number` and `tx_hash`
- `min_bond`, current `bounty`, `LogFundAnswerBounty` entries

**Answer history — ordered, complete, one entry per event**
- `answer` (bytes32, hex, **not decoded**), `bond`, `ts`, `user`, `is_commitment`,
  `history_hash`, `block_number`, `tx_hash`
- for commit-reveal, both the `LogNewAnswer` commitment and the matching
  `LogAnswerReveal` (`answer_hash`, `answer`, `nonce`, `bond`)
- the bond token: `native` or the ERC20 address, plus symbol and decimals, so bonded value
  is comparable across deployments

**Arbitration**
- `arbitrator` address, and its human name if known (Kleros court, appeals-only, etc.)
- `LogNotifyOfArbitrationRequest`: `user` (requester), `ts`, `block_number`, `tx_hash`,
  arbitration fee paid
- the arbitrator's imposed answer (`submitAnswerByArbitrator` /
  `assignWinnerAndSubmitAnswerByArbitrator`): `answer`, `answerer`, `ts`, `tx_hash`
- `LogCancelArbitration` if emitted
- where the arbitrator is Kleros: `disputeID`, and the cross-reference needed to join §2

**Finalization**
- `LogFinalize.answer` (bytes32, raw), `finalize_ts`, `block_number`, `tx_hash`
- `LogReopenQuestion` links (`question_id` ↔ `reopened_question_id`) in both directions

**Please preserve the special answer values verbatim.** `0xffff…ffff` ("Invalid") and
`0xffff…fffe` ("Answered Too Soon") must not be normalised away or dropped — those cases
are the ones we most want, because they are exactly where a solver *should* abstain, and
measuring abstention against them is a core metric.

**A note on what we expect to find.** Questions asked against pre-3.2 contracts carry
no description field at all — the title is the entire question, with no separate
resolution criteria. That is faithful to what the bonders themselves saw, and we will
score those cases as-is, but if the disputed population turns out to be mostly pre-3.2
we would like to know early, because "ambiguous criteria" then partly means "no written
criteria". A count of disputed questions per contract version, sent ahead of the full
export, would answer that in one line.

### 1.4 Why each group matters to us

- Raw `question` string → we reconstruct `question` and `resolution_criteria` for the solver
  without paraphrasing the protocol's wording.
- Full bond ladder → stratification by real-world disagreement intensity: number of distinct
  competing answers, number of flips, peak bond, total value bonded.
- Arbitration timestamps → the leakage cutoff. Solvers are replayed as of the moment the
  dispute arose, so they cannot read later coverage saying how it settled.
- `LogFinalize` → the sole ground truth. Nothing else scores the benchmark.

---

## 2. Kleros — where Reality.eth escalated to arbitration

For each `disputeID` referenced in §1, or for all disputes whose arbitrable is a Reality.eth
arbitrator proxy / the Kleros oracle:

- `disputeID`, arbitrable contract address, `arbitrator` address, chain
- court / subcourt id and name, number of jurors drawn, `metaEvidence` (the question as
  presented to jurors — the full JSON, not a summary)
- per round: votes cast per option, whether the round was appealed, appeal funding per side,
  round start and end timestamps
- final `ruling` (raw integer), ruling timestamp, tx hash
- evidence submissions: submitter, timestamp, and the evidence **content**. Evidence is
  IPFS-addressed and IPFS is blocked here, so please include the documents inline or as a
  side archive keyed by dispute id rather than as bare CIDs.
- `evidenceGroupID`

Evidence timestamps matter as much as the evidence: they tell us what was knowable at the
time, which is what a solver replaying the case is entitled to see.

---

## 3. UMA Optimistic Oracle / Polymarket — fallback if §1–2 are unavailable

Only disputed assertions; undisputed proposals are out of scope.

- `assertionId` / `requestId`, chain, OO version (V2 / V3 / Skinny)
- `identifier` (e.g. `YES_OR_NO_QUERY`, `MULTIPLE_VALUES`)
- `ancillaryData` — **raw bytes and the exact decoded string**. This carries the question
  text and the resolution rules, and is the field we most need verbatim.
- requester, `proposer`, `proposedPrice`, proposal timestamp, `liveness`, bond
- `disputer`, dispute timestamp, dispute bond
- DVM: vote round id, commit/reveal window timestamps, final `resolvedPrice`, resolution
  timestamp, total voting weight per outcome
- where the requester is Polymarket: market slug, question title, description and the
  written resolution-source text as published at market creation, plus market creation and
  end timestamps

---

## 4. Delivery format

- **JSONL** (one JSON object per case, UTF-8, `\n`-delimited) or CSV with a documented
  header. JSONL strongly preferred — the answer history is nested.
- Raw hex for all bytes32 values, decimal strings for uint256 (not JS numbers — bonds
  overflow 2^53).
- Timestamps as Unix seconds, plus block numbers.
- One file per protocol; a `manifest.json` naming the snapshot block per chain and the exact
  filter applied.
- Expected size: well under 1 GB even unfiltered. Any transfer channel is fine.

Our validator (`bench/ingest-disputes.mjs` in this directory, schema at
`schema/dispute-export.schema.json`) checks a delivered file field-by-field and reports
exactly what is missing, so a partial first sample is genuinely useful — send 20 cases and
we will tell you within minutes whether the shape is right before you export the rest.

## 5. What we are explicitly **not** asking for

- No opinion on whether a resolution was correct. We score against the protocol's recorded
  outcome even where we suspect it was wrong, and we analyse suspected oracle errors
  separately.
- No summaries, paraphrases, translations or cleaned-up question text.
- No hand-picked "good examples". The mechanical filter in §1.2 is the whole selection rule.
- No off-chain commentary, forum threads or social context — we want the protocol record.
