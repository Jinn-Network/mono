# Claimant walkthrough: a Terminal-Bench 2.1 run, from an empty directory to a checked bundle

You run Terminal-Bench 2.1 on Harbor yourself. This document lists every command you type around that run, in order, until someone else has checked the result on their own machine.

Colophon does not run the benchmark on this path. It seals your method before the run. After the run it reads what Harbor wrote. Then it writes a bundle: one directory of files that says what was planned, what happened and what follows, in a form anyone can recompute.

Read [what import claims, and what it does not](EXTERNAL-RUN-IMPORT.md#what-import-claims-and-what-it-does-not) first. It is one table, and it says what the result proves.

## How to read this document

- Type each command as shown. Put your own value where the text is in angle brackets.
- The examples use the workspace `./ws`, the principal `me` and the draft `tb21`. The principal is the name you act under. `init` gives it every permission in the workspace, so use the same one on every command.
- The commands come in the order of the published claimant path: `init`, `draft create`, `method`, `arm add`, `quote`, `lock`, `anchor`, `run import`, `collect`, `report`, `publish`. `anchor` is optional.

The outputs shown are real. They were recorded by typing these commands against a Harbor 0.21.0 record kept in this repository, described in [its README](core/test/fixtures/harbor-0.21-jobs-terminal-bench-2-1/README.md). Four things follow from that.

- That record holds trials for three of the ten tasks. So the import below reports 14 cells not delivered, and the page reads "Partial comparison". A run of all ten tasks reports none.
- The scores in that record are not a result. It was made under emulation.
- The record is dated 2026-10-01, so the commands ran with the clock set to that day.
- The anchor came from a test authority on the same machine, and was checked with that authority's certificate. The public authority named below is the example for you to use.

The two `harbor run` commands were not run again for this document. Harbor 0.21.0 accepted both with `--print-config`, which resolves a job and runs nothing.

## What you need

- Node 22 or newer.
- Linux x64 or Apple-silicon macOS. `quote` is a required step and is known to run on those two. On Linux arm64 it fails with a loader error ([#4950](https://github.com/Jinn-Network/mono/issues/4950)).
- Docker. Harbor runs each task in a container.
- Harbor, version 0.21.0 exactly. `run import` refuses a job that any other version wrote, and names the job.
- A key for the model your agent calls. Harbor uses it. No Colophon command asks for it.
- Two arms. A run compares configurations, so a draft needs at least two. A claim about one arm alone is not supported in this release (decision 3 of [DR-2026-10-06](../../log/decisions/2026-10-06-terminal-bench-2-1-bring-your-run.md)). If you have one agent, add Harbor's `oracle` agent as the second. It applies each task's reference solution and calls no model. It is your control: an oracle that fails a task on your machine tells you not to trust that machine's result for the task.

Check the Harbor version before anything else.

```sh
harbor --version
```

```text
0.21.0
```

Two rules of order hold for everything below. `lock` comes before the Harbor run. `anchor` comes before `run import`.

## 1. `init`: create the workspace

```sh
npx @colophon-claims/cli@0.1 init --workspace ./ws --principal me
```

It creates `./ws` and prints its path. Every later command names it with `--workspace`.

## 2. `draft create`: create the draft

```sh
npx @colophon-claims/cli@0.1 draft create --workspace ./ws --principal me \
  --name "Terminus 2 on Terminal-Bench 2.1" --id tb21
```

```text
created draft tb21 (draft)
```

Every later command names the draft with `--draft tb21`.

## 3. `method`: bind Terminal-Bench 2.1

```sh
npx @colophon-claims/cli@0.1 method terminal-bench-2.1 --workspace ./ws --principal me --draft tb21 \
  --slice 10 --replicates 1
```

```text
bound official terminal-bench-2.1 method bcb489457f51ee3e79052de3201d23f0dcd96222e7058d8ec5c3553f9f97379d for draft tb21
```

- `--slice` takes `1`, `10` or `all`: the first task, the first ten, or all 89, in name order. `--ids <csv>` names tasks instead. Pass one of them.
- `--replicates` is the number of trials you plan for each task. It is 1 when you leave it out.
- Binding also sets the run window: 2 hours for each task and replicate, and never less than 24 hours. Ten tasks at one replicate get 24 hours. All 89 at five get 890 hours.

The suite fixes the task list and the scorer. Each task is sealed with the digest of its Harbor package and with the rule that turns Harbor's reward into a verdict: pass at 1, fail at 0, inconclusive for any other value.

## 4. `arm add`: add two arms

```sh
npx @colophon-claims/cli@0.1 arm add --workspace ./ws --principal me --draft tb21 --arm terminus-2 \
  --pinning '{"agent":{"id":"terminus-2"},"model":{"id":"<provider>/<model>"}}'
```

```text
added arm terminus-2 to draft tb21
```

```sh
npx @colophon-claims/cli@0.1 arm add --workspace ./ws --principal me --draft tb21 --arm oracle \
  --pinning '{"agent":{"id":"oracle"}}'
```

```text
added arm oracle to draft tb21
```

A pinning is a JSON object that says what the arm is. It is sealed at `lock` and published with the claim. Two arms cannot have the same pinning.

For a Harbor run, write the agent as `agent.id` and the model as `model.id`. Use the exact values you will give Harbor with `-a` and `-m`. You may add other keys, such as a version.

How a trial is matched to an arm. At `run import`, each Harbor trial must match exactly one arm, or the import is refused. An arm matches when either holds:

- the arm id equals the Harbor agent name;
- `pinning.agent.id` equals the Harbor agent name and, when the arm sets it, `pinning.model.id` equals the Harbor model name.

The two arms above match both ways, which is the safe choice: name the arm after the agent, and pin the agent and the model.

## 5. `quote`: a stopgap

```sh
npx @colophon-claims/cli@0.1 quote --workspace ./ws --principal me --draft tb21
```

```text
quoted draft tb21: 20 cells, ok=false
unsupported-requirement: arm terminus-2: pinning key "agent" is not in backend runPinning inventory
unsupported-requirement: arm terminus-2: pinning key "model" is not in backend runPinning inventory
unsupported-requirement: arm oracle: pinning key "agent" is not in backend runPinning inventory
run size: 20 solve + 20 evaluation = 40 cells
  terminus-2: 10 solve + 10 evaluation
  oracle: 10 solve + 10 evaluation
coverage: supported keys harness, isolationPolicy, jinn.benchmark-product/evaluator
  refused terminus-2/agent: pinning key "agent" is not in backend runPinning inventory
  refused terminus-2/model: pinning key "model" is not in backend runPinning inventory
  refused oracle/agent: pinning key "agent" is not in backend runPinning inventory
hard cap: not declared
venue inventory: ok=false and each unsupported-requirement and refused line above describe what the local venue could run itself.
  They do not block lock, and they do not apply to a run brought with run import.
```

`quote` is a stopgap. `lock` accepts only a quoted draft, so you run it. It asks this machine what it could run by itself, which is not your question, and `ok=false` is expected. The ruled design is that `lock` takes an unquoted draft for a brought run. When it does, this step goes away. See decision 4 of [DR-2026-10-06](../../log/decisions/2026-10-06-terminal-bench-2-1-bring-your-run.md).

The 20 cells are ten tasks by two arms by one replicate.

## 6. `lock`: seal the method

```sh
npx @colophon-claims/cli@0.1 lock --workspace ./ws --principal me --draft tb21 --ack-sample-size
```

```text
At the declared n=10 per arm, no pass rate this run can have gives a 95% interval wider than 0.5268. At this and neighboring sample sizes:
  n=10: interval width 0.5268
  n=20: interval width 0.4014
  n=5: interval width 0.6592
Cells that do not score (excluded, or conflicted across replicates) lower the denominator and widen the interval past this.
locked draft tb21: run f4938240939283b252ec78b6287ab8517ee77637ce53657c8c07e20ab86f9d27, closes 2026-10-02T12:07:00.393Z
run import --from harbor accepts the Harbor run of this lock only when:
  Harbor is version 0.21.0
  retries are off: harbor run --max-retries 0, which is Harbor's default
  the dataset is the sealed revision: harbor run --dataset terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a
  each task has one trial for each replicate: harbor run --n-attempts 1
  every trial starts after this lock and ends before the close time above
This run plans 1 trial of each task. A Terminal-Bench 2.1 run with fewer than 5 trials of each task is not leaderboard-comparable.
```

The lock cannot be undone. From here the tasks, the arms, the replicate count and the run window are fixed.

`--ack-sample-size` says you have read the lines above the receipt. They say how wide the interval can be at this number of trials. Without the flag, `lock` prints them and seals nothing.

The line that starts `locked draft` holds two values to keep.

- The Run digest, the 64 characters after `run`. It names exactly what you sealed. The anchor in the next step covers it. The report page prints it as "Run SHA-256". The checker prints it on its `Run:` line. A reader who holds this digest from before the run can see that the bundle is that run.
- The close time. Every trial must start after the lock, and end before the close time and before you import.

The lines under the receipt say what the Harbor run must meet. One of them is stricter than the import: a task with fewer trials than replicates is accepted, and each missing trial is recorded as not delivered. A task with more trials than replicates is refused.

## 7. `anchor`: anchor the lock

An anchor is a signed statement from an outside party that your Run digest existed at a stated time. With it, a reader can check that your method was fixed no later than that time. Without it, your claim says that pre-registration is a discipline this tool enforces and not a proof against you.

This step is optional. A claim publishes without it.

**When.** After `lock` and before `run import`. Do it before you start Harbor, so the stated time is earlier than your first trial. `run import` marks the run as started, and a lock anchor is refused from then on.

**The two provider values.** `--provider` takes one of these. They name two proof formats. They are not addresses, and nothing is fetched from them.

- `https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1`: a timestamp authority answers with a signed token. The proof is complete at once.
- `https://spec.jinn.network/trust/anchor-profiles/opentimestamps/v1`: OpenTimestamps calendars. The first `anchor` stores a pending proof. A later second `anchor` completes it, and that one must also come before `run import`. A proof that is still pending changes nothing in the claim.

**The endpoint.** `--endpoint` is the address of the service to ask. Colophon ships none, so you choose one. The command below uses one public timestamp authority. It is an example and not a default.

```sh
npx @colophon-claims/cli@0.1 anchor --workspace ./ws --principal me --draft tb21 --subject lock \
  --provider https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1 \
  --endpoint http://timestamp.digicert.com
```

```text
anchored the sealed lock record f4938240939283b252ec78b6287ab8517ee77637ce53657c8c07e20ab86f9d27 with https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1: f4432af8fb3630b50dc3465960ca77b8e910e66c745909f26cec71e5dbf35aae (present)
```

The first digest is your Run digest. The second names the stored anchor record.

**What `present` and `verified` mean.**

- `present`: the token is well formed, it covers your Run digest, and its signature holds against the certificate inside it. Nobody has yet said whether that certificate is to be trusted. This is the expected result here.
- `verified`: a reader supplied the authority's root certificate, and the token's certificate chain reaches it. Only a reader can produce `verified`, because the checker ships with no trusted certificates.

**What this sends.** One request to the endpoint. It carries the SHA-256 digest of the sealed Run record and nothing else. The authority sees the digest, the time and your network address. This endpoint is plain HTTP, so the request can also be seen on the network path. A reply that does not cover your digest, or does not verify, is refused and nothing is stored.

**If the reply is refused.** Colophon keeps a token only when it is signed with SHA-256 or stronger, names its signing certificate in a SigningCertificateV2 attribute, and that certificate is marked for time stamping only, as a critical extension. Some public authorities do not meet this. Try another, or publish without an anchor.

**Once only.** An anchor is written once. A second `anchor` with the same provider is refused as a conflict and sends nothing.

**Stored configuration.** `anchoring configure` stores a provider so that `lock` asks for the anchor itself. It keeps `https` addresses only, so it does not take this example.

## The commitment

The anchored lock is your public commitment. The anchor record travels in the bundle, and a reader checks it there. Nothing has to be posted before the run. No other command exports a commitment, and none is needed (decision 5 of [DR-2026-10-06](../../log/decisions/2026-10-06-terminal-bench-2-1-bring-your-run.md)).

Posting is an extra. Put the Run digest that `lock` printed somewhere public before you run. A reader then compares it with the `Run:` line the checker prints. On its own, a posted digest proves no order of events.

Tell your readers which authority you used. The report page does not name it, and neither does the checker's output.

## 8. `inspect`: read the Harbor dataset and task names

```sh
npx @colophon-claims/cli@0.1 inspect --workspace ./ws --principal me --draft tb21
```

It prints the draft as JSON. The part Harbor needs is at the end:

```text
      "officialSlate": {
        "protocol": "terminal-bench-2.1",
        "datasetId": "terminal-bench/terminal-bench-2-1",
        "datasetRevision": "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a",
        "harborDataset": "terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a",
        "harborTaskNames": [
          "terminal-bench/adaptive-rejection-sampler",
          "terminal-bench/bn-fit-modify",
          "terminal-bench/break-filter-js-from-html",
          "terminal-bench/build-cython-ext",
          "terminal-bench/build-pmars",
          "terminal-bench/build-pov-ray",
          "terminal-bench/caffe-cifar-10",
          "terminal-bench/cancel-async-tasks",
          "terminal-bench/chess-best-move",
          "terminal-bench/circuit-fibsqrt"
        ]
      }
```

`harborDataset` is the value for Harbor's `-d`. Each entry of `harborTaskNames` is one `-i`.

## 9. Run Harbor

Run one Harbor job for each arm. Put both under one directory, here `jobs`.

```sh
harbor run -d 'terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a' \
  -a terminus-2 -m <provider>/<model> --n-attempts 1 --max-retries 0 -o jobs --job-name terminus-2 \
  -i terminal-bench/adaptive-rejection-sampler -i terminal-bench/bn-fit-modify \
  -i terminal-bench/break-filter-js-from-html -i terminal-bench/build-cython-ext \
  -i terminal-bench/build-pmars -i terminal-bench/build-pov-ray -i terminal-bench/caffe-cifar-10 \
  -i terminal-bench/cancel-async-tasks -i terminal-bench/chess-best-move -i terminal-bench/circuit-fibsqrt
```

```sh
harbor run -d 'terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a' \
  -a oracle --n-attempts 1 --max-retries 0 -o jobs --job-name oracle \
  -i terminal-bench/adaptive-rejection-sampler -i terminal-bench/bn-fit-modify \
  -i terminal-bench/break-filter-js-from-html -i terminal-bench/build-cython-ext \
  -i terminal-bench/build-pmars -i terminal-bench/build-pov-ray -i terminal-bench/caffe-cifar-10 \
  -i terminal-bench/cancel-async-tasks -i terminal-bench/chess-best-move -i terminal-bench/circuit-fibsqrt
```

- `-d` is the dataset at the sealed revision.
- `-a` and `-m` are the agent and the model you pinned.
- `--n-attempts` is the number of trials of each task. Make it your replicate count. Harbor's `-n` is a different flag: it sets how many trials run at once.
- `--max-retries 0` keeps retries off. That is also Harbor's default. A job that allowed retries is refused at import.
- `-o jobs --job-name <name>` puts each job under `./jobs`.

When both jobs finish, you have `./jobs/terminus-2` and `./jobs/oracle`. Do not edit anything in them.

## 10. `run import`: bring the run in

```sh
npx @colophon-claims/cli@0.1 run import --from harbor ./jobs --workspace ./ws --principal me --draft tb21
```

```text
imported 20 cells into draft tb21: 6 graded, 0 ungradeable, 14 not delivered
```

- `graded`: a finished trial whose Harbor result holds a reward. The reward is recorded, and the sealed rule gives the verdict. A trial that ran to its agent timeout and still got a reward is graded by that reward.
- `ungradeable`: a finished trial whose reward cannot be read.
- `not delivered`: a planned slot with no finished trial, or a trial that ended in a timeout or an error with no reward. It stays in its arm's planned slots.

No slot is dropped. There is no exclude flag.

This slate takes a Harbor jobs directory and nothing else. `run import --file` and `run import --template` are refused on it.

A run that finished before the lock cannot be brought onto it. Each of its trials is dated before the window opens, and the import is refused. Lock first, then run Harbor.

## 11. `collect`: close the run

```sh
npx @colophon-claims/cli@0.1 collect --workspace ./ws --principal me --draft tb21
```

```text
collected draft tb21: matrix 3d371382f11cb6d12541897d5e1a36f615c59419f27c0b61c798058a85963914
```

## 12. `report`: produce the report

```sh
npx @colophon-claims/cli@0.1 report --workspace ./ws --principal me --draft tb21
```

```text
reported draft tb21: report c67408161f7e46705901c273c7c0c6b974fd2aa44f67aa87a44ab64497e416fc, preregistered=true, claim written
```

## 13. `publish`: write the bundle

```sh
npx @colophon-claims/cli@0.1 publish --workspace ./ws --principal me --draft tb21
```

```text
published draft tb21: bundle 73b9b7eb9e06ee2554a4344e92f300e2540a76fb15e2e1a9e2b524ef660df011 at artifacts/tb21/public-bundles/73b9b7eb9e06ee2554a4344e92f300e2540a76fb15e2e1a9e2b524ef660df011
```

`publish` uploads nothing. It writes one directory on your disk. The path it prints is inside the workspace, so the directory is `./ws/artifacts/tb21/public-bundles/<bundle identity>`. That directory is the whole claim.

## Host it

Check the directory yourself first. This is the command the claim prints, with your directory in it.

```sh
npx @colophon-claims/check@0.2.1 ./ws/artifacts/tb21/public-bundles/<bundle identity>
```

Then put the directory, unchanged, anywhere that serves files over HTTP: a static site, an object store, a file server. Keep every file name and the layout. `index.html` in it is the report page. No Colophon command uploads it, and the `publication` verbs are not part of this path.

Host exactly these files. The checker refuses a directory that lacks a file the bundle lists, and one that holds a file it does not list. A stray `.DS_Store` is enough to fail a reader's check.

Next to the address, state the Run digest and the timestamp authority you used.

## Check it from a second machine

The reader needs Node 22 and the address. No account, no workspace and no Harbor.

`bundle.json` lists every file of the bundle. The reader fetches it, then each file it lists. Here the bundle is hosted at `https://example.org/tb21`.

```sh
curl -fsS --create-dirs -o bundle/bundle.json https://example.org/tb21/bundle.json
```

```sh
node -e 'for (const { path } of require("./bundle/bundle.json").files) if (path.split("/").every((part) => /^\w[\w.-]*$/.test(part))) console.log(path)' | xargs -I{} curl -fsS --create-dirs -o bundle/{} https://example.org/tb21/{}
```

The second command fetches only plain relative paths. A listed path of any other shape is skipped, and the checker then reports that file as missing.

Now the command the claim prints. `claim-package.json` pins it as `verification.command`, and the page and the bundle's `README.md` repeat it.

```sh
npx @colophon-claims/check@0.2.1 ./bundle
```

```text
Recomputed: 8 of 8 checks passed
Bundle: sha256:73b9b7eb9e06ee2554a4344e92f300e2540a76fb15e2e1a9e2b524ef660df011
Format: benchmark-product-public-bundle/10
Run: f4938240939283b252ec78b6287ab8517ee77637ce53657c8c07e20ab86f9d27

Not checked by this tool: whether the machine that produced this bundle was
honest, and whether the compared identities are independent parties. What is
recomputed is the bundle's integrity, evidence closure, signing trust,
calculations, the report, claim consistency, anchor well-formedness, and the
external-import marker — against the bytes the bundle carries, nothing else.

manifest                  passed       every listed file is here, unaltered
evidence-closure          passed       every run's evidence is carried here
trust                     passed       the signing keys match the identities
matrix-rederivation       passed       the run tally follows from the evidence
report-verification       passed       the result follows from the runs
claim-consistency         passed       the claim agrees with the records here
integrity-anchors         passed       the timestamp proofs are well formed
external-import           passed       the import marker matches the claim

Signed by
  publisher · 1 key
    key sha256:3c658846491e6d136009031ce3828a31b12f51f3dacd2f528ce317299a80b2dc — no domain bound
  automated grader — same operator · 1 key

Anchors
  lock anchor · authority-time · present · 2026-10-01T12:30:00Z
    time basis not evaluated: no trust material supplied
    record f4432af8fb3630b50dc3465960ca77b8e910e66c745909f26cec71e5dbf35aae

Anchor subjects
  lock: anchored
  matrix: absent — no anchor was carried and none was declared

An anchor dates the bytes it covers and says nothing else about the run: not
that results were produced after it, and not that the anchoring authority is
independent of the bundle's owner.
No files were uploaded.
Protocol identifiers are names, not addresses — this verifier fetches nothing
from them. Checks run against the exact platform bytes installed from npm.
```

The `Run:` line is the digest `lock` printed. The checker opens no network connection.

Without trust material the anchor reads `present`. To have its time evaluated, the reader gets the authority's root certificate and passes it. Get it from the authority, never from the bundle or from the claimant. For the example authority:

```sh
curl -fsS -o digicert-trusted-root-g4.pem https://cacerts.digicert.com/DigiCertTrustedRootG4.crt.pem
```

```sh
openssl x509 -in digicert-trusted-root-g4.pem -noout -fingerprint -sha256
```

```text
sha256 Fingerprint=55:2F:7B:DC:F1:A7:AF:9E:6C:E6:72:01:7F:4F:12:AB:F7:72:40:C7:8E:76:1A:C2:03:D1:D9:D2:0A:C8:99:88
```

That is the SHA-256 fingerprint of DigiCert Trusted Root G4. Compare it before you use the file.

```sh
npx @colophon-claims/check@0.2.1 ./bundle --tsa-root ./digicert-trusted-root-g4.pem
```

```text
Anchors
  lock anchor · authority-time · verified · 2026-10-01T12:30:00Z
    time basis evaluated against trust material you supplied
    record f4432af8fb3630b50dc3465960ca77b8e910e66c745909f26cec71e5dbf35aae
```

`verified` means the token's certificate chain reaches the certificate the reader supplied, and each certificate in it was valid at the stated time. The checker does not check revocation.

With a root that is not the authority's, the check still passes and the anchor stays `present`:

```text
    time basis not evaluated: the trust material you supplied does not verify this anchor
```

`--tsa-root` takes a DER or PEM file and can be repeated.

## What the page says

Open `index.html`, or read the bundle's `README.md`. On a run brought this way they say the following.

**Task names and rewards.** Each task is listed by its official name, with its dataset, revision and package. Each cell shows its verdict and its reward: a graded cell reads "Verdict: pass" or "Verdict: fail", then "1 reward (higher-is-better)" or "0 reward (higher-is-better)". A slot that was not delivered reads "No solve output is present for this accounted cell" and "expired".

```text
- **adaptive-rejection-sampler** — Terminal-Bench 2.1 task; dataset terminal-bench/terminal-bench-2-1 at revision 7d7bdc1cbeda; package bcaa2399985c
```

**The coverage line.** Under the scope, above every rate:

```text
Tasks: 10 of the 89 in Terminal-Bench 2.1.
```

A run of the whole dataset reads `all 89 in Terminal-Bench 2.1`.

**The rate header.** The rate column says what it is a rate of.

```text
| Arm | Judged n | All planned slots | Not in the denominator | Pass rate over judged cells | Wilson low | Wilson high |
|---|---:|---:|---:|---:|---:|---:|
| oracle | 3 | 10 | 7 | 1.0000 | 0.4385 | 1.0000 |
| terminus-2 | 3 | 10 | 7 | 0.3333 | 0.0615 | 0.7923 |
```

The header reads "Terminal-Bench 2.1 accuracy" only when the run covers all 89 tasks and every planned cell of every arm reached a pass or fail verdict. In every other case it reads "Pass rate over judged cells", and the two columns before it say how many cells were left out. An arm with no judged cell shows "No rate is stated".

**The comparability sentence.** Every run brought this way carries it, once in each limitation list:

> This run is not a Terminal-Bench 2.1 leaderboard submission: it was run outside Colophon and imported from a Harbor jobs directory, and nothing in this bundle shows that it met the leaderboard's protocol. The pass rate is taken over the cells that reached a pass or fail verdict. A trial with no reward is left out of that rate and counted in the accounting, so the rate can be higher than Harbor's mean for the same job, which counts such a trial as 0.

**Two pre-registration sentences.** An anchored bundle shows both, in different places. The two readable limitation lists, "Sealed Report limitations" and "Stored Claim limitations", carry the unanchored sentence, because the Report is sealed with it whether or not an anchor exists:

> Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.

The anchored sentence is in the claim's stored trust boundary. The page prints it under "Local self-run trust boundary stored in the Claim", and the README under "Venue honesty", both as JSON:

> Pre-registration here is anchored: an external timestamp authority asserts this run's sealed design digest existed no later than 2026-10-01T12:30:00Z. That assertion proves the design's existence by that time and nothing else about the run — in particular, not that results were produced after it — and it is only as good as the authority behind the signing key named in the token.

The page names neither Harbor's version nor the timestamp authority. `claim-package.json` holds the Harbor version under `externalImport`, and the anchor's time and the SHA-256 of its signing certificate under `anchors`. The authority's name is yours to state.

## What is published

Everything in the bundle directory is public once you host it. Nothing is redacted.

The bundle holds the sealed method, the records of every cell, the signed report, the claim, the anchor record, the import record `external-import.json`, and the report page. It also holds the evidence files of every graded or ungradeable trial, byte for byte as Harbor wrote them. For each such trial, where the file exists:

- `result.json` and `config.json`;
- `verifier/reward.txt`, `verifier/reward.json` and `reward.json`;
- `artifacts/prediction.json`;
- `agent/trajectory.json`, the agent's trajectory;
- `agent/recording.cast`, the terminal recording.

Read them before you publish. A trial's `result.json` holds the path of the trial directory on your machine and, for a trial that raised an error, a stack trace. A trajectory holds the task instruction as the agent saw it and everything the agent then read and wrote.

A slot that was not delivered carries no evidence file. The slot and its reason are in `external-import.json`.

## Limits of this release

- **Two arms.** A draft with one arm is refused at `quote`.
- **`quote` is required.** It is a stopgap, as step 5 says.
- **One replicate by default.** `method --replicates <n>` plans more. Fewer than five trials of each task is not leaderboard-comparable, and no brought run is a leaderboard submission.
- **The run window.** 2 hours for each task and replicate, and never less than 24 hours. It is set at `method` and sealed at `lock`. A trial dated before the lock or after the close time is refused.
- **Harbor 0.21.0 only, retries off.** A job from another version, or one that allowed retries, is refused by name.
- **Evidence caps.** One evidence file may be at most 8 MiB. All evidence of a run together is capped at 4 MiB for each planned cell, or at 64 MiB when that is more. A run may have at most 10,000 cells.
- **One rate for each arm.** A run on this slate reports each arm's pass rate with its interval. It states no comparison between the arms and no winner.
- **Platforms.** The claimant commands need Linux x64 or Apple-silicon macOS, because `quote` does. The checker needs only Node 22.

[`EXTERNAL-RUN-IMPORT.md`](EXTERNAL-RUN-IMPORT.md) has the full rules of the Harbor reader. [`PUBLIC-BUNDLE.md`](PUBLIC-BUNDLE.md) describes the bundle format.
