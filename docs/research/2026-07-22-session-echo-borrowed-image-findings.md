# Session-echo borrowed-image live verify — findings (#1644)

**Date:** 2026-07-22
**Issue:** [#1644](https://github.com/Jinn-Network/mono/issues/1644)
**Shape:** `test` — verification / findings, not a product change to mint policy
**Raw result path:** `~/.jinn-client/swe-rebench-v2/session-echo-live-result.json`

---

## Issue purpose

`mineSessionEchoes` borrows eval infra (`image_name`, `install_config`, `test_patch`)
from the first scorable same-repo validated-pool instance via
`findSourceInstanceForRepo`, then runs empirical test derivation and mint
admission. Unit tests mock `EvalRunner`, so real Docker/pytest behavior of that
borrow was unverified.

**Review hypothesis:** under borrow-mismatch (session `acceptedDiff` is not the
borrowed source’s gold patch), the failure mode is **zero yield**
(`rejected:empirical-dead` / dead-mint), not **bad admits**.

This issue ships a re-runnable live verify path and records one real attempt’s
outcome.

---

## Method

| Knob | Value |
|---|---|
| Entrypoint | `cd client && yarn task-creator:session-echo-live` (`scripts/session-echo-live-verify.ts`) |
| Mode | `borrow-mismatch` (default) |
| Repo | `conan-io/conan` (default after held-out denylist; `sympy/sympy` refuses before Docker) |
| Source instance | `conan-io__conan-18327` |
| Borrowed image | `swerebench/sweb.eval.x86_64.conan-io_1776_conan-18327:latest` |
| Donor gold (mismatch) | `conan-io__conan-18444` |
| Host arch | `arm64` (amd64 image via emulation) |
| Historical disk-floor override | `JINN_EVAL_DISK_FLOOR_GB=10` on the 2026-07-22 retry; this is recorded as evidence, not recommended practice (default gate is 20 GB) |
| Publish | `false` (admission only) |
| Eval wiring | production `mineSessionEchoes` → real `PythonEvalRunner` + `HttpHfFetcher` |

Classifier: `_swe-rebench-v2-session-echo-live-classify.ts` (hermetic Vitest coverage).

Runbook: `docs/runbooks/harvest-e2e-smoke.md` § Session-echo borrowed-image live verify.

---

## Attempt timeline

### (a) First live run — disk-floor infra-block

Default `JINN_EVAL_DISK_FLOOR_GB=20` blocked on a host with ~16–18 GB free.
Classification: **infra-blocked** (disk floor). No Docker pull / empirical grade.

### (b) Retry with floor override — Docker credentials

```bash
JINN_EVAL_DISK_FLOOR_GB=10 yarn task-creator:session-echo-live
```

Passed the disk gate and reached the Docker image pull path for the borrowed
conan eval image. Pull failed with **`docker_credentials_error`**
(`error getting credentials` signature in `PythonEvalRunner`).

### (c) Graded admission — SoR artifact

A later run completed Docker grading and wrote the operator result JSON with
`rejected:other` / `gold-patch-not-resolved (f2p 0, p2p_broke 0)`. That file is
the campaign SoR (see Final classification + Appendix).

---

## Final classification

**`rejected:other`** — authoritative SoR is
`~/.jinn-client/swe-rebench-v2/session-echo-live-result.json` (see Appendix).

Rejection reason: `gold-patch-not-resolved (f2p 0, p2p_broke 0)`.

Earlier attempts (a)/(b) were **infra-blocked** (disk floor →
`docker_credentials_error` on pull). The latest recorded run completed Docker
grading far enough to emit an admission-path product reason, not infra.

### (d) 2026-07-24 exact-head re-verification — Docker daemon infra-block

After reclaiming space, the host had 21 GiB free and therefore cleared the
unmodified 20 GB disk floor. Both configured local Docker contexts resolve to
the same Docker Desktop socket; bounded 20-second `docker info` probes against
each context timed out with no daemon response. No alternative Colima,
OrbStack, Podman, or Rancher context was configured.

Classification: **infra-blocked** at preflight. No image was pulled, no
container ran, no publication path ran, and the prior result artifact was not
overwritten. The 2026-07-22 graded artifact remains the campaign SoR.

Not product-red for the red-flag sense (no admit under mismatch). Not
`rejected:empirical-dead` either — so AC2’s review hypothesis is still
unconfirmed.

---

## Hypothesis status

**Not confirmed.**

Zero-yield under mismatch was observed (`admitted: []`), but the failure mode
was `gold-patch-not-resolved`, not `rejected:empirical-dead`. That is
inconclusive for the “dead-mint, not bad-admit” hypothesis: it is still
zero-yield and not a red-flag admit, but it does not confirm the hypothesized
empirical-dead path.

No red-flag admit was observed on the runs that reached classification JSON.

---

## What was verified

- Production wiring reaches `mineSessionEchoes` with a real `PythonEvalRunner`
  (not a mocked EvalRunner) and resolves a borrowed same-repo image + donor gold
  for mismatch.
- Held-out / capability-slate denylist correctly blocks `sympy/sympy` before Docker;
  default live repo is `conan-io/conan`.
- Outcome classifier + opt-in yarn script + harvest smoke runbook section shipped
  and are re-runnable without reading the PR thread.
- Docker preflight is bounded to 20 seconds, so an unresponsive daemon fails
  closed rather than hanging the operator session.
- Evaluator setup is checked against the production current-enable contract
  without invoking the harness's Docker readiness probe. Legacy v1 markers,
  stale pinned commit/bundle/parser metadata, unmanaged checkout paths, and
  missing checkouts fail closed with the re-enable instruction before
  `PythonEvalRunner` is constructed.
- The default 20 GB disk floor remains the documented safety requirement.

---

## Follow-up

Re-run on a clean host when aiming to confirm empirical-dead specifically
(current SoR already graded past Docker pull and landed
`gold-patch-not-resolved`). Prerequisites that have blocked attempts:

1. Docker Hub credentials / image pull for the borrowed source image, and
2. a responsive Docker daemon, and
3. host has at least the default 20 GB free-disk floor.

Expected under the review hypothesis (borrow-mismatch): `rejected:empirical-dead`.
Any `admitted` under mismatch is a red flag.

```bash
cd client
yarn task-creator:session-echo-live
cat ~/.jinn-client/swe-rebench-v2/session-echo-live-result.json
```

---

## Appendix — result JSON snapshot fields

Authoritative operator artifact (`session-echo-live-result.json`):

```json
{
  "mode": "borrow-mismatch",
  "repo": "conan-io/conan",
  "hostArch": "arm64",
  "sourceInstanceId": "conan-io__conan-18327",
  "borrowedImage": "swerebench/sweb.eval.x86_64.conan-io_1776_conan-18327:latest",
  "donorInstanceId": "conan-io__conan-18444",
  "discovered": 1,
  "admitted": [],
  "rejected": [
    {
      "instance_id": "conan-io__conan__session-f3297e7fe953",
      "reason": "gold-patch-not-resolved (f2p 0, p2p_broke 0)"
    }
  ],
  "classification": "rejected:other",
  "hypothesisHolds": false,
  "infraError": null,
  "elapsedSec": 285
}
```

Campaign AC2 verdict: **`rejected:other`** (inconclusive for empirical-dead).
Earlier attempts (a)/(b) were infra-blocked; they are not the SoR for the
final classification once a graded admission reason was recorded.

Note: the on-disk `hypothesisHolds: false` was written by the pre-review
classifier. Post-fix classification of the same rejection is
`hypothesisHolds: null` (inconclusive — neither empirical-dead confirmation
nor bad-admit disproof).
