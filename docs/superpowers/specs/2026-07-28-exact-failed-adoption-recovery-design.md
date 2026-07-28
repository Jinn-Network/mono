# Exact Failed-Adoption Recovery Design

## Context

The live Autopilot marketplace canary delivered Task `1197` successfully, then
the local GitHub adoption observer marked its durable run `FAILED` before any
GitHub read. The persisted identities are intentionally in two namespaces:

- `run.taskId` is the numeric on-chain protocol Task correlation (`"1197"`).
- `run.task.id` is the semantic runtime identity
  (`"autopilot:<v2AttemptId>"`).
- A strict `jinn-repo.v1` Autopilot spec carries the same semantic identity in
  `spec.instance_id`.

The observer incorrectly required `run.task.id === run.taskId`. Existing tests
hid the defect by giving both fields the numeric correlation.

The already-delivered Task must remain the only top-level Task. Recovery must
not repeat execution, snapshots, packaging, or Mech delivery.

## Identity contract

For a strict Autopilot-backed `jinn-repo.v1` run:

1. `run.taskId` remains the numeric on-chain Task ID used by delivered-output
   and receipt correlation.
2. `run.task.id === spec.instance_id`.
3. `spec.instance_id === "autopilot:" + spec.session.v2AttemptId`.
4. `run.task.role === run.taskRole`.
5. Delivered-output correlation continues to require
   `correlation.taskId === run.taskId`.

The observer derives the strict spec before checking semantic identity. It
must never compare the semantic runtime ID to the numeric protocol Task ID.

## Recovery surface

Add an operator command:

```text
jinn recover-failed-adoption \
  --request-id <exact-request-id> \
  (--dry-run | --apply) \
  --json
```

The command accepts exactly one request ID and requires an explicit mode.
`--dry-run` performs every validation and reports eligibility without writing.
`--apply` performs the same validation and one compare-and-swap update.

There is no bulk scan, automatic startup migration, Task-ID selector, wildcard,
or implicit apply mode. A concurrent or changed row is a refusal, not success.

## Eligibility guards

The recovery service rejects unless all of these durable facts hold:

- the exact request ID exists and the row is `FAILED`;
- `failure_reason` is exactly
  `adoption-contradiction:persisted runtime Task identity or role is contradictory`;
- the last adoption observation is exactly the corresponding structured
  contradiction;
- no accepted adoption receipt is persisted;
- the row has one numeric on-chain Task ID and non-negative attempt index;
- solver type, runtime contract, runtime role, and persisted role are the
  strict `jinn-repo.v1` Autopilot shapes;
- semantic runtime ID equals strict `spec.instance_id`, and that instance ID
  equals `autopilot:<v2AttemptId>`;
- receipt repository, PR, and authorized authors equal the strict session;
- delivered producer output binds successfully to the persisted envelope CID;
- delivered correlation equals the numeric `run.taskId`, attempt index,
  request ID, envelope CID, V2 attempt, claim OID, PR, and expected head;
- manifest CID, delivery transaction, delivery digest, evidence hash,
  adoption wait timestamp, failure timestamp, and next observation timestamp
  are present and well formed.

The apply update repeats all recovery-critical values in its SQL `WHERE`
clause: request ID, terminal state, exact failure and observation, no accepted
receipt, Task/attempt/role/solver identity, immutable task payload, delivered
output, envelope and delivery evidence, and adoption/failure timestamps. Zero
changed rows means the compare-and-swap lost and recovery fails closed.

## State change

An eligible apply changes only:

- `state`: `FAILED` to `AWAITING_ADOPTION`;
- `state_updated_at`: current recovery time;
- `failure_reason` and `failure_at`: cleared;
- `adoption_last_error`: cleared;
- `adoption_next_observation_at`: current recovery time.

It preserves the prior observation and attempt count as audit evidence until
the normal observer replaces them. It also preserves every Task, snapshot,
artifact, output, manifest, delivery, receipt-policy, and correlation field.

The ordinary engine tick then enters only `awaitAdoption()`. There is no
transition through `RUNNING`, `POST_SNAPSHOT`, `PACKAGING`, or `DELIVERING`,
and no code path repeats the Mech delivery.

## Live ordering

1. Land and review the observer correction and exact recovery command.
2. Build the exact reviewed commit and restart the sole daemon with that build.
3. Run Autopilot in recover-only mode. Its submitted manifest independently
   observes the existing on-chain Solution, verifies/applies it, and posts an
   authenticated accepted receipt.
4. Read back the exact receipt and unchanged delivered Task evidence.
5. Run the recovery command in `--dry-run` mode for the exact request.
6. Run the same command once with `--apply`.
7. Let the fixed daemon observe the already-published receipt and continue only
   through Router claim and same-Task evaluator readiness.

No live row mutation is allowed before the reviewed build is running and the
accepted receipt is present.

## Alternatives

- Observer fix plus external Autopilot recovery is insufficient: the local row
  remains terminal, so it cannot observe the receipt or claim delivery.
- A new Task is forbidden and would not prove same-Task recovery.
- Manual SQL is rejected because it lacks a reviewable guard contract,
  dry-run, atomic compare-and-swap, and reusable tests.

## Verification

Tests must prove:

- a production-shaped row with numeric `taskId` and semantic runtime ID reaches
  GitHub observation rather than contradiction;
- a mismatched semantic runtime ID still fails closed;
- every recovery guard independently refuses;
- dry-run is write-free;
- apply changes only the documented columns;
- a stale/concurrently changed row loses the compare-and-swap;
- the recovered row enters `AWAITING_ADOPTION`, and engine recovery invokes
  receipt observation without executing, snapshotting, packaging, or
  delivering.
