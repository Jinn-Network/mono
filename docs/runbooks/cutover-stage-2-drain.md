# Cutover stage 2 — drain and deploy runbook

> **Superseded 2026-08-05** per
> [DR-2026-08-05](../../log/decisions/2026-08-05-cutover-one-swap-collapse.md): stages
> 2–4 collapsed into one swap with one combined drain —
> [`cutover-one-swap-drain.md`](cutover-one-swap-drain.md) is the operative runbook.
> The R1/R2 merge-block below is **dissolved** (DR decision 9): the host byte-equality
> reseal and the grant-free native derivation removed both ratification needs. This file
> is retained as the historical stage-2 procedure; do not run it.

Contract 10 (evaluator flow). Run in order. Do not deploy with step 2 unfinished.

> **Merge blocked** on human ratification of addenda §3 **R1** (self-signer grant) and **R2**
> (bridge subject) in `docs/superpowers/plans/2026-07-30-implementation-program-addenda.md`
> until an operator signs those. See the stage-2 plan Findings 1 and 3.
>
> **Still open for step 5:** one verdict closed-loop on **testnet** (fleet). Record tx hashes,
> announcement id, and `decisionGrade: true` in the deploy PR before stage 3 begins.
>
> See `docs/superpowers/plans/2026-07-30-cutover-stage-2-evaluator-flow.md` (Task 17). Step 5's
> fleet gate must pass before stage 3 work starts.

## 1. Freeze intake (previous canary, no new build)

On every fleet operator still running the **pre-stage-2** image, stop admitting new evaluation
opportunities through the legacy path. The mech adapter's evaluation-opportunity ingest respects
the `#547` evaluator gate — it scans and ingests only when this operator holds the `evaluator`
role in at least one joined SolverNet.

- [ ] For each operator, remove `evaluator` from every `joinedSolverNets[<manifestCid>].roles`
      entry (or stop the daemon outright). Restart so the adapter boots with the gate off.
- [ ] Confirm the adapter is not ingesting: no new `evaluation_submitted` events appear in
      `jinn history` after the restart, and no new evaluation `task_runs` rows open.

```bash
# In-flight legacy evaluations (delivery-watcher / TaskEngine path)
sqlite3 ~/.jinn-client/jinn.db \
  "SELECT request_id, task_id, state FROM task_runs \
   WHERE task_role='evaluation' AND state NOT IN ('COMPLETE','FAILED','RACE_LOST')"
```

## 2. Drain

- [ ] Let in-flight legacy evaluations run to terminal states. Watch both signals:
  - **Daemon history** — `jinn history --limit 50` (or the dashboard Activity card) for
    `evaluation_submitted` events; each one should be followed by a settled verdict on chain.
  - **Router claim state** — for each open verdict `requestId` from the query above, confirm
    `claimed(requestId)` on the router eventually returns `true`:

```bash
cast call <ROUTER_ADDRESS> "claimed(bytes32)(bool)" <REQUEST_ID> --rpc-url <RPC_URL>
```

- [ ] Poll every 5 minutes until the SQLite query returns 0 rows **and** every tracked
      `requestId` reports `claimed == true`, or until the operator's patience bound elapses
      (recommended: 2 hours).
- [ ] Anything still open at the deadline is a **straggler** (step 3).

## 3. Record stragglers

- [ ] List `(taskId, attemptIndex, requestId)` for every unterminated legacy evaluation in the
      deploy PR body. Today-mode has no on-venue release, so a stranded verdict claim occupies
      its `maxClaims` slot until the revised generation's deadline reap; the §4
      `unreleased_attempt` state message names it to the operator. The drain exists to make this
      list empty in practice.

## 4. Deploy

- [ ] Ship the stage-2 image to one operator first. On that operator, set
      `evaluator.enabled: true` (or `JINN_EVALUATOR_ENABLED=1`) and ensure the operator holds
      the `evaluator` role in at least one joined SolverNet. Restart-required — no hot reload.
- [ ] First boot runs **derivation-first recovery** (program §6.3): the projector cursor catches
      up to the finalized chain head before the evaluator loop admits its first opportunity. Confirm:
  - the `[rpc] L2 transport` line is present
  - `[work] claim gate open — the projector cursor reached the finalized chain head` appears
    within 10 minutes of boot (same catch-up gate the work loop uses)
  - the `evaluator` loop registers in the watchdog (`LOOP_REGISTRY` includes `evaluator`;
    `delivery-watcher` and `engine-*` are gone)
- [ ] Deploy to the rest of the fleet.

## 5. Verify the gate

One verdict closed-loop on testnet through the **new** evaluator loop:

- [ ] An opportunity from **another operator's** solution delivery (not self-evaluation).
- [ ] `openVerdictAttempt` on chain (opens and claims the verdict request in one tx).
- [ ] An evaluation-profile Attempt appears in the backend journal.
- [ ] The sealed Delivery carries a DSSE Result Evaluation Statement.
- [ ] `claimVerdictDelivery` with the envelope's verdict code.
- [ ] The projector emits the verdict announcement with `decisionGrade: true`.

Record in the deploy PR: task id, attempt index, request id, `openVerdictAttempt` tx,
mech `Deliver` tx, `claimVerdictDelivery` tx, the announcement id, and confirmation that
`decisionGrade` is `true`.

## Rollback

Revert the stage-2 PR train or pin the previous canary image. Rollback abandons the new
loop's in-flight evaluations: chain state stays consistent (claims are chain facts; the
backend journal persists), but the reverted daemon does not resume them and the same
`unreleased_attempt` state message names them. The legacy evaluation machinery is gone from
the new image but present in the pinned one, so a rollback restores the old path intact.
