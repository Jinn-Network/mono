# Real disputed oracle cases: experiment blocked at the data-acquisition gate

**Date:** 2026-08-19 · **Predecessor:** [`REPORT.md`](REPORT.md) (synthetic benchmark, ceiling effect)

## Summary

No experiment was run. The brief requires ground truth to come exclusively from a
protocol's own historical resolution, and forbids substituting a reconstruction. Every
route to Reality.eth, Kleros and UMA records is refused by this environment's egress
policy. Per the brief's instruction, I stopped at that gate and produced the export
request instead: [`DATA_REQUEST.md`](DATA_REQUEST.md).

What was built: a validating ingest path so a delivered export becomes a runnable
benchmark without further design work, and the leakage safeguards §4 asks for. What was
not built: any dataset.

---

## 1. Access attempt

Tested from the execution container on 2026-08-19. All failures are `403` on `CONNECT`
recorded by the agent proxy as *"policy denial"* — an organizational allowlist, not DNS
failure, not rate limiting, not a transient error.

| target class | hosts tested | result |
|---|---|---|
| Ethereum / Gnosis / Polygon JSON-RPC | `eth.llamarpc.com`, `cloudflare-eth.com`, `ethereum.publicnode.com`, `rpc.ankr.com`, `rpc.gnosischain.com`, `gnosis.publicnode.com`, `rpc.gnosis.gateway.fm`, `polygon-rpc.com`, `polygon.publicnode.com` | all blocked |
| The Graph | `api.thegraph.com`, `gateway.thegraph.com`, `api.studio.thegraph.com`, `gateway-arbitrum.network.thegraph.com` | all blocked |
| block explorers | `api.etherscan.io`, `api.gnosisscan.io` | blocked |
| protocol frontends | `reality.eth.limo`, `reality.eth.link`, `realitio.github.io` | blocked |
| UMA / Polymarket | `api.uma.xyz`, `oracle.uma.xyz`, `gamma-api.polymarket.com`, `clob.polymarket.com` | blocked |
| IPFS (Kleros evidence) | `ipfs.io`, `gateway.pinata.cloud`, `cloudflare-ipfs.com` | blocked |
| archives / dataset hosts | `web.archive.org`, `archive.org`, `huggingface.co`, `datasets-server.huggingface.co` | blocked |
| **reachable** | `github.com`, `raw.githubusercontent.com`, `registry.npmjs.org`, `pypi.org` | **200** |

The same block applies to the `WebFetch` tool, which returns `EGRESS_BLOCKED` for these
hosts. `WebSearch` works because it executes server-side, but it returns model-summarised
snippets — using it to transcribe bonded-answer histories would put a model back inside
ground truth, which is the precise failure the brief exists to prevent.

**What the reachable hosts do and do not give.** GitHub carries the Reality.eth and Kleros
subgraph *source* (schema, mappings) but not indexed data; indexed data needs a Graph
endpoint. npm carries `@reality.eth/contracts`, which I did download and use — it supplied
the authoritative event signatures, deployment addresses per chain, and the built-in
question templates that `DATA_REQUEST.md` and the ingester are built on. It contains no
question, answer or dispute records. Targeted searches for a published dump of
Reality.eth/Kleros/UMA disputes on the reachable hosts found none.

**Conclusion:** genuine disputed cases are unobtainable here. No substitute was created.

---

## 2. What was built instead

### 2.1 The export request — `DATA_REQUEST.md`

Specifies exactly which cases and which fields, grounded in the contracts rather than
described loosely:

- **A cheaper alternative first.** Allowlisting a single Ethereum + Gnosis RPC endpoint
  unblocks the entire dataset with no third-party involvement — `eth_getLogs` over the
  Reality.eth deployments reconstructs the full question and bond history directly from
  the chain. The export request is only needed if that is impossible.
- **Reality.eth (primary):** the eight mainnet/Gnosis/Polygon deployments with addresses
  and first blocks; a purely mechanical selection filter (finalized **and** either ≥2
  distinct bonded answers or an arbitration request); and per-case fields named against
  the `RealityETH-3.0` ABI — `LogNewQuestion`, `LogNewAnswer`, `LogAnswerReveal`,
  `LogNotifyOfArbitrationRequest`, `LogFinalize`, `LogReopenQuestion`.
- **Kleros:** dispute id, court, jurors, per-round votes, appeals, ruling, and evidence
  **inline** rather than as IPFS CIDs, since IPFS is unreachable here.
- **UMA/Polymarket:** raw and decoded `ancillaryData`, proposal, dispute, DVM round and
  resolved price.
- **An explicit non-request list:** no opinions on correctness, no summaries, no
  paraphrased question text, no hand-picked examples.

Three details in it came out of reading the contracts and would have silently corrupted
the benchmark if assumed instead:

1. **Template id semantics changed between contract versions.** Field 2 of the bool
   template is `category` before v3.2 and `description` from v3.2 on. A fixed id-to-field
   mapping would mislabel the criteria of every question on one side of that boundary. The
   request therefore asks for `template_text` on every row, and the ingester parses the
   `%s` placeholders out of that string rather than assuming an id mapping.
2. **Reality.eth's special answers must survive the export.** `0xffff…ffff` ("Invalid")
   and `0xffff…fffe` ("Answered Too Soon") are exactly the cases where a solver *should*
   abstain, and they are the only way to measure whether abstention is calibrated. A
   well-meaning export that normalised them away would delete the most valuable rows.
3. **Pre-3.2 questions have no criteria field at all** — the title is the whole question.
   If the disputed population is mostly pre-3.2, then "ambiguous criteria" partly means
   "no written criteria", which changes what the experiment is measuring. The request asks
   for a per-version count up front so this is known before the full export.

### 2.2 Ingest path — `bench/ingest-disputes.mjs`, `schema/dispute-export.schema.json`

Turns a delivered export into the two-file benchmark in the format the brief specifies.
It is model-free end to end: mechanical decoding, keyword-based topic exclusion with every
decision logged to `ingest-log.json`, and no fallback that invents data — with no export
it exits non-zero.

It derives the stratification the brief asks for straight from the bond ladder: number of
distinct competing answers, number of flips, peak and total bonded, arbitrated vs
bonded-only, appeal rounds, evidence count. The replay cut-off is set at the arbitration
request (falling back to the last competing answer), so solvers are replayed at the moment
the dispute existed but was unsettled.

Cases are held back rather than admitted on a guess: non-boolean templates (the solver
schema is YES/NO/UNRESOLVABLE and an answer-matching rule for select/uint types has not
been designed), custom templates whose text was not supplied, and cases with no usable
cut-off. Verified against a fixture at `bench/fixtures/shape-check.jsonl` covering both
template regimes, a custom template, an `INVALID` resolution, a topic exclusion and a
malformed row. **That fixture is a parser test, not data — it is never a benchmark.**

### 2.3 Leakage safeguards — `hooks/websearch-guard.mjs`

Extended for this dataset, since historical pages do reveal settled answers:

- the banned-term list now covers protocol frontends, explorers, subgraphs, DVM/arbitrator
  machinery and outcome-seeking phrasings ("how did it resolve", "jurors ruled");
- **near-verbatim title search is refused** — a query reproducing 8+ consecutive words of
  the question is denied, which stops the exact-title search that surfaces the settlement
  record while leaving paraphrase and keyword search working (verified both ways);
- every query is logged with its decision, matched term and the case's cut-off.

**Stated limitation, not solved:** the guard cannot verify the publication date of a page
a solver reads. The prompt instructs solvers to disregard anything postdating the cut-off,
and `src/solver.mjs` now carries that instruction plus the cut-off itself, but this is an
instruction, not enforcement. Any case where clean historical replay cannot be
demonstrated must be excluded from the primary evaluation, per §4 of the brief — which
requires the real data to identify.

### 2.4 Harness

Unchanged, as the brief requires. `src/solver.mjs` accepts the new
`{question, resolution_criteria, cutoff_time, public_metadata}` shape alongside the old
one; conditions A/B/C, aggregation and scoring are untouched and untuned. `source_protocol`
is deliberately withheld from the solver prompt — naming the venue points at the record we
are excluding.

---

## 3. Why no experiment was run on anything else

The obvious shortcut is to have an agent locate historical disputes by search and record
what it finds. That reproduces the exact defect that made the previous run uninformative:
a claim can only enter the set if an agent could establish its answer, so the population is
defined as "resolvable by a web agent" and a single agent scoring near 100% on it is close
to tautological. The previous benchmark's own numbers show this — 145/145 for one Opus
agent, 1.4% solver disagreement, zero on the deliberately harder stratum.

A second reconstruction would have produced another confident-looking null on a population
that cannot test the hypothesis. The hypothesis lives specifically where real bonded
counterparties disagreed, and only the protocols' records identify those cases.

---

## 4. What happens when the data arrives

1. `node bench/ingest-disputes.mjs --in <export.jsonl> --report-only` — validates shape and
   reports what is missing. Worth running on a 20-case sample before a full export.
2. Same command without `--report-only` → `bench/real/{claims.public.json,truth.json}`.
3. `node src/run-experiment.mjs --claims bench/real/claims.public.json --out results/attempts-real.jsonl`
4. `node src/aggregate.mjs --claims bench/real/claims.public.json …`
5. `node src/score.mjs --claims bench/real/claims.public.json --truth bench/real/truth.json …`

Before scoring, two things need doing that require the data: a manual leakage audit of the
search logs on a sample, marking cases where clean replay cannot be shown; and adding the
strata from §2.2 to `src/score.mjs`'s breakdowns, which currently splits on the old
benchmark's difficulty labels. Both are small; neither can be done blind.

Cost, extrapolating from the previous run at 6 attempts per case: roughly **$1 per case**,
so $50–200 for a 50–200 case dataset, at about 30 seconds per solver attempt with 10-way
concurrency.

---

## 5. Open flag on the alternative hypothesis

The brief asks to watch for the possibility that Jinn's value is not aggregation. The
previous run produced one weak signal worth carrying forward and testing properly here:
across 145 claims solvers disagreed twice, and on both the aggregation step correctly
overruled the dissenting solver. The mechanism functions; that benchmark simply never
exercised it. Whether that generalises to cases where humans bonded money against each
other is precisely the open question, and it is unanswerable until the data exists.

Also untested and worth measuring on the real set, since abstention never once fired on the
synthetic benchmark: whether a solver correctly identifies the `INVALID` and
`ANSWERED_TOO_SOON` cases. If it does, that is a directly useful product — flagging
questions that cannot be safely resolved before they consume arbitration — and it is
independent of whether aggregation beats a single agent.

---

## Verdict

**INCONCLUSIVE**

The dataset of genuine historically-disputed, externally-resolved cases could not be
acquired: every Reality.eth, Kleros, UMA, RPC, subgraph, explorer, IPFS and archive host is
refused by this environment's egress policy, and no substitute was created because a
reconstructed benchmark cannot test this hypothesis. No comparison was run, so nothing is
known about multi-solver performance on real disputes — this is a statement about data
access, not a result about Jinn.

Unblocking is cheap and does not require the protocol teams: allowlisting one Ethereum and
one Gnosis RPC endpoint is sufficient, since the full question and bond history can be read
directly from contract logs. Failing that, `DATA_REQUEST.md` is ready to send.
