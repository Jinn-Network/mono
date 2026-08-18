# Colophon self-serve experience

- **Version:** 0.6
- **Date:** 2026-08-13
- **Updated:** 2026-08-17 — first public npm cut may pin one exact stack-canary receipt ([DR-2026-08-17-c](../log/decisions/2026-08-17-colophon-first-cut-canary-pin.md)); §5.5 official TB 2.1 protocol vs “select a supported task” ([DR-2026-08-17-b](../log/decisions/2026-08-17-official-suite-protocol.md)); engine-wrap vs Harbor campaign ([DR-2026-08-17](../log/decisions/2026-08-17-runtime-engine-direct-mode.md)); 2026-08-14 qualification notes retained
- **Status:** Accepted; implementation authorized 2026-08-13
- **Decision owner:** Operator
- **Design scope:** From a cold product-site visitor to a locally published, independently verified benchmark bundle
- **Source of record:** This repository
- **Review:** Architecture-boundary and standards/adversarial passes completed 2026-08-13; zero-Docker macOS arm64 qualification, local Mac Docker/Inspect acceptance, and cheapest-capable Claude and Codex provider-path acceptance added 2026-08-14

## 1. Decision summary

Colophon's public v1 install surface should be one top-level npm application package, invoked with `npx` for the no-commitment first run and installable as the `colophon` command for continued use. The accepted identity, pending successful registry reservation, is:

- npm organization/scope: `@colophon-claims`;
- product operations: `@colophon-claims/core`;
- runner: `@colophon-claims/cli`;
- reader verifier: `@colophon-claims/verify`;
- private local-UI source package: `@colophon-claims/web`.

The scope is deliberately not `@colophon`: that scope's `cli` package is already used by an unrelated project. `@colophon-claims` matches the product domain and the plain promise, “Publish benchmark claims people can check,” without pretending to own the generic word. Reservation and publisher custody remain publication gates; the product identity itself is accepted.

The standing target remains coherent **stable** `@jinn-network/*` releases. [DR-2026-08-17-c](../log/decisions/2026-08-17-colophon-first-cut-canary-pin.md) names one exception: Colophon's **first** public npm cut may pin exact `0.1.0-canary.sha.<fullSha>` versions from **one** stack-canary receipt (not the floating `canary` dist-tag). After that cut, the next pin change waits for the first stable stack receipt. npm, not the visitor, resolves and installs the graph; the visitor never clones the mono or builds its distributions. This preserves the stack's source/package boundaries instead of copying the platform into a product-owned bundle.

The reader verifier is a second, smaller package built from the same verification implementation. `npx @colophon-claims/verify ./bundle` verifies a received bundle without installing the runner, workspace, launchers, Docker integration, or Python/Inspect runtime. It is the first packaging increment because a report is not genuinely checkable when checking it requires the report producer's full development environment.

The reader package is a **reference convenience, not the specification**. The standing precondition is that product-neutral benchmarking schemas, named procedures, and golden/adversarial conformance fixtures are retrievable at `https://spec.jinn.network/` without cloning this repository. For the first public cut only ([DR-2026-08-17-c](../log/decisions/2026-08-17-colophon-first-cut-canary-pin.md)), those bytes are the exact platform tarballs on npm at the pinned canary versions; the live spec origin is not hosted, and that gap must be disclosed. The Colophon public-bundle format and its own product-level test vectors must also be published, clearly non-normative for the platform. A third party must still be able to implement the record procedures without importing or naming Colophon, and to implement the Colophon bundle checks without installing Colophon — after the spec origin is live. Until then, independent implementation from `$id` URLs is the named unproven claim.

These are three Colophon-owned Tier 4 packages over a published platform, not a public mirror of every workspace package:

- core owns the operations library and product composition used by the runner and local UI;
- the runner installs one user-facing application, including `bundle verify`;
- the reader package installs only the verifier and its public evidence schemas/assets;
- each pins only the smallest published `@jinn-network/*` runtime closure it actually needs, at one coherent platform set;
- neither exposes Jinn workspace packages as Colophon commands or asks a user to coordinate their versions;
- both declare the public-bundle format versions they accept, and use one verifier implementation against the same product-neutral conformance corpus.

The installed npm graph is a **deployment boundary only**. It does not merge the source architecture: protocol and protocol-extending record packages remain behavior-free; reusable applications remain product-neutral and one-job; Colophon remains the tier-4 composition. Existing source-boundary, package-inventory, packed-types, and conformance guards stay authoritative before publication.

The operator has selected **`@colophon-claims` under a new Colophon-controlled npm organization**. Package metadata must explain rather than blur the identity boundary: Colophon's public GitHub face is `ritsukai`; the source of record remains in the Jinn-Network mono; the platform packages publish as Jinn-Network. Publisher custody and registry reservation remain publication prerequisites, not implementation blockers.

The source and GitHub Issue source of record stay in this mono for now. A published mirror or separate repository is a later option, not a prerequisite for self-serve packaging.

## 2. Why this design exists

Today the public proof is honest but contributor-shaped:

1. clone the entire mono;
2. install Node 22 and Yarn 4;
3. build roughly 22 workspace dependency distributions in CI order;
4. run `yarn public-quickstart` from `packages/benchmark-product/core`.

That flow proves important things. It uses no account, API key, network credentials, or funds; runs a bundled benchmark against two real subprocess arms; publishes a complete bundle; copies the bundle; removes the source workspace; and has the standalone verifier return six checks from the copy. But the quickstart then removes its temporary root, including the copied bundle. It proves the product to a contributor; it does not leave a cold visitor with a usable published artifact.

The self-serve design must preserve that proof while changing who performs the release and setup work. The Jinn release train publishes a coherent platform set; Colophon CI installs that set from the registry and proves its product package in a clean environment. The visitor runs Colophon.

This serves the GTM program's artifact-led loop:

- **report readers** need a small way to check a received bundle;
- **repo tinkerers** need a one-command sample before they invest in configuration;
- **concierge conversions** need a supported seam for their own tasks and real agent harnesses.

Publication remains demand-gated. On 2026-08-13 the operator separately authorized
pre-publication implementation and local testing of Increments 1–3 in this mono,
without filing Issues. That authorization does not publish packages, mutate the
site, or create a second repository.

## 3. Evidence and constraints

### 3.1 Product truths to retain

The existing product establishes these invariants:

- the display name is **Colophon** and the command is `colophon`;
- the promise is “Publish benchmark claims people can check”;
- `publish` means local immutable bundle emission, not upload;
- the public sample needs no account, API key, network credentials, funds, or Docker;
- a copied bundle is verified without its source workspace;
- verification returns these six checks in canonical order:
  1. `manifest`
  2. `evidence-closure`
  3. `trust`
  4. `matrix-rederivation`
  5. `report-verification`
  6. `claim-consistency`
- a bundle is non-confidential and must disclose trust and assurance limits plainly;
- the verifier must not imply that using a Colophon-branded implementation is the only way to check the public evidence format.
- sealed records are hashed as the exact received bytes; a verifier never parses and re-emits or re-canonicalizes a record and calls it the same document;
- a bundle path, package URL, repository, or report name is never the bundle or record's canonical identity.

### 3.2 Release truths to design around

`packages/benchmark-product/core` is currently private. Its clean CI build constructs 23 platform dependency distributions in a strict order before it builds the product. The existing external-consumer smoke test succeeds by packing those packages as local tarballs and installing all of them together. At the time of this design, representative platform packages are not available as stable public npm dependencies.

This design records publication of the required Jinn packages as an upstream precondition, not as Colophon packaging work. A release candidate is valid only when it can install its exact dependency set from the public registry in a clean directory. Workspace protocols, Yarn portals, local tarballs, the floating `canary` dist-tag, and `resolutions` that hide a workspace are forbidden in that proof. Exact `0.1.0-canary.sha.<fullSha>` version pins from one stack-canary receipt are allowed for the first public cut only ([DR-2026-08-17-c](../log/decisions/2026-08-17-colophon-first-cut-canary-pin.md)).

The mono has a canary-on-integration and Monday stable train. Colophon does not follow every platform cut. After the first cut it pins one coherent **stable** Jinn platform set and may publish multiple product-only versions against it. When Colophon needs a new platform API, it waits for the next compatible stable cut and upgrades the complete set deliberately. That is a dependency gate, not a rule that every Colophon release must coincide with Monday. It avoids the release-train trap without copying the platform closure into Colophon.

The existing extraction assessment is not green. Stable registry dependencies, component-only CI, independent conformance/release protection, and other extraction gates remain open. Moving source to another repository now would move the dependency problem rather than solve it.

The mono already contains the product-neutral building blocks this design must preserve: published-shape schemas and fixtures under `packages/benchmarking/records`, and the benchmarking conformance corpus under `packages/benchmarking/testing`. The missing off-mono property is distribution: those schemas and kits are not yet served at `spec.jinn.network`. First-cut npm tarballs at a pinned canary receipt are a public retrieval path that is not that origin. Colophon's separate `PUBLIC-BUNDLE.md` and verifier tests own the product-level closure. Colophon packaging must not fill the platform gap by turning a product run or bundle into a normative tier-1–3 fixture.

### 3.3 GTM authority

This design follows the concierge-first, artifact-led direction in:

- `docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md`
- `docs/superpowers/plans/2026-08-10-colophon-gtm-execution-program.md`

Those plan files were reviewed at commit `54e1f4070` on `origin/claude/benchmark-gtm-plan-docs`; they are not yet present on `integration/evidence-v1` as of this spec's date.

### 3.4 Stack architecture constraints

This product design consumes, and does not amend, the approved stack boundary:

- Benchmark, Run, Matrix, and Report remain tier-2 product-neutral record kinds.
- The run procedure, aggregation, and SWE-bench interop remain tier-3 product-neutral capabilities.
- Inspect selection/execution remains a tier-4 runtime adapter.
- Colophon is a tier-4 composition. Nothing in tiers 1–3 may import, name, or use a Colophon fixture as normative evidence.
- A deployment tarball may contain compiled code from several tiers, but the source dependency direction and executable architecture guards remain intact.
- Conformance kits and specification/reference-derived fixtures precede packaged implementations. A fixture captured from a Colophon product run may test the tier-4 public-bundle projection, but it may not become a tier-1–3 oracle.
- Immutable records and append-only observations stay distinct from mutable local workspace state. Verification never edits a published bundle.
- The product is the credential-grant authority for its runs; the backend only resolves declared secret references mechanically and never originates, persists, or infers credentials.

## 4. Goals, non-goals, and success

### 4.1 Goals

1. A cold visitor with a supported Node version can create and retain a verified sample bundle with one command.
2. A reader can verify a received bundle without installing the runner or cloning the mono.
3. A user can progress from the sample to supported coding tasks and real Claude Code or Codex harnesses without a bespoke source edit.
4. Every install and run boundary says what is local, what may use the network, whose credentials or provider billing may be involved, and what was published.
5. Packaging can be released on demand against one coherent stable Jinn platform set without requiring a new platform cut for product-only changes.
6. Each increment is triggered by observed demand, not by speculative platform work.
7. The official reader command is replaceable: the underlying schemas, exact-byte rules, named procedures, and conformance fixtures are public and product-neutral.

### 4.2 Non-goals

- hosted execution, hosted verification, accounts, telemetry, analytics, or usage tracking;
- a network venue, marketplace execution, payments, or funding flows;
- network-venue code in the public v1 runner closure; v1 self-serve is a local product profile;
- general plugin or arbitrary-shell execution in public v1;
- extraction to a separate repository in this increment;
- Windows support unless a release explicitly qualifies it;
- changing the `colophon-claims/site` repository before an increment ships.

### 4.3 Success conditions for the target v1

From a clean, supported machine:

- the visitor names one runner package; npm resolves its exact stable Jinn dependency graph without any mono checkout or local build;
- the sample leaves a public bundle on disk and the six checks pass against the copied bundle after the source workspace is gone;
- the sample performs no application network call, does not read ambient API credentials, requires no Docker, and spends no funds;
- the printed verifier command works using only the smaller reader package;
- the user's first real supported benchmark can be preflighted before any agent call that may incur provider cost;
- the artifact identifies its format, producing Colophon version, source commit, and compatible verifier line;
- clean-install, golden-bundle, tamper, and unsupported-environment tests fail closed with actionable messages.
- a non-Colophon implementation can obtain the schema/kit without cloning the mono and can test the same exact-byte verification contract.
- a third-party bundle verifier can obtain the Colophon public-bundle format and product-level vectors without treating them as platform semantics.

## 5. The intended experience

### 5.1 Reader path: receive, check, understand

A report or bundle carries a copyable command shaped like:

```sh
npx @colophon-claims/verify@1 ./bundle
```

The exact published package name remains subject to the reservation gate in section 6. The package has one executable, so `npx` can infer it. In this package, a bundle path defaults to verification; the longer `colophon bundle verify --bundle ./bundle` grammar remains available after a global install and in the full runner. Its only other surfaces are version/help and a machine-readable capability query.

Do not add `--yes` to the human quickstart. npm's first-download confirmation is meaningful supply-chain consent. CI and other non-interactive callers can select their own npm confirmation policy.

Success output starts with the answer:

```text
Verified: 6 of 6 checks passed
Bundle: sha256:<bundle-id>
Format: benchmark-product-public-bundle/2

manifest                passed
evidence-closure        passed
trust                   passed
matrix-rederivation     passed
report-verification     passed
claim-consistency       passed

This checks the bundle's integrity, evidence closure, calculations, report,
and claim consistency. It does not prove that the machine that produced the
bundle was honest or that the compared identities are independent parties.
No files were uploaded.
```

`--json` remains stable for automation and returns the six canonical checks plus verifier version, accepted format, bundle identity, and failure details. Human output uses plain language; machine output does not mix with progress messages.

The reference verifier:

- reads only the supplied bundle;
- opens no network connection at verification time;
- reads no ambient credentials or product workspace state;
- does not require Docker, Python, Git, an agent CLI, or the full Colophon package;
- verifies an authenticated file snapshot and does not reopen paths after authentication;
- rejects unsupported bundle formats before making partial claims;
- treats bundle contents as hostile input: never executes or dynamically imports a bundle file, never follows a link outside the authenticated root, and applies documented size/count limits before unbounded allocation;
- exits non-zero on any failed check and names the failed check and evidence path;
- hashes sealed records exactly as received and never verifies a digest by re-canonicalizing parsed JSON;
- includes links to the separately published product-neutral schemas, named procedures, and conformance vectors so another implementation can reproduce the checks;
- never treats a Colophon-generated bundle as the normative oracle for tier-1–3 behavior.

The npm install itself downloads code from the selected registry. The package README and site distinguish that install network access from verification-time behavior. The Colophon packages have no install, preinstall, or postinstall lifecycle scripts. Published Jinn dependencies used by the verifier must meet the same no-build-on-install constraint; native/static assets are packaged by the owning release rather than fetched from mutable URLs.

Each bundle includes two commands in its reader instructions:

- the exact verifier version used when the producer published it, for reproduction;
- the compatible major line, for current fixes that preserve the bundle-format contract.

Within a verifier major, a patch or minor release must continue to accept every bundle-format version that major advertises. Tightening that makes a previously valid bundle fail requires either a security advisory with an explicit compatibility disposition or a new major/format line; `@1` cannot silently rewrite an old claim's verification rules.

### 5.2 Visitor path: one command to the first aha

The site's eventual primary command is:

```sh
npx @colophon-claims/cli@1
```

`npx install Colophon` is not valid npm grammar: `npx` already means “obtain this package, then run its executable,” and a following `install` would be treated as the executable/package to run. The no-argument Colophon executable is therefore the shortest honest first run. An installed user gets the same behavior from `colophon`; `colophon demo` is the explicit repeatable spelling. An unscoped `trycolophon` launcher is not required for v1: it would be another release and supply-chain surface merely to save scope characters. Reserve it if useful, and publish it only after command-friction evidence.

The command owns the complete sample journey. It:

1. checks Node, OS/architecture, writable space, and its packaged assets;
2. prints the no-account/no-key/no-funds/no-Docker contract before execution;
3. creates a temporary source workspace;
4. runs the bundled sample benchmark against the two existing subprocess arms;
5. publishes a local immutable bundle;
6. copies the bundle to a user-owned output directory;
7. removes the temporary source workspace;
8. verifies the copied bundle with the same verifier code;
9. retains the copied bundle, a non-sealed run receipt, and next-step examples;
10. when interactive, starts a loopback-only verified viewer and opens it; otherwise prints the absolute bundle path. `--no-open` and `--json` keep the path headless and deterministic.

With no flags it creates a new directory without overwriting an existing path:

```text
./colophon-quickstart-<timestamp>-<random>/
  bundle/
  quickstart-receipt.json
  NEXT-STEPS.md
```

The receipt records the Colophon package version, source commit, bundle format and identity, Node version, OS/architecture, completion time, and six-check result. It contains no credentials and is outside the immutable bundle. The command supports an explicit `--output`, refuses a non-empty target, and deletes only a temporary directory that it created and still owns.

The first lines are a contract, not marketing:

```text
Colophon will run a bundled sample locally.
No account, API key, funds, or Docker are needed.
The sample does not use your agent logins or upload files.
```

The last lines state what happened and what did not:

```text
Published locally; nothing was uploaded.
Bundle: <absolute-path>/bundle
Identity: sha256:<bundle-id>
Verified: 6 of 6 checks passed

Check it again:
  npx @colophon-claims/verify@1 <absolute-path>/bundle

Use your own work:
  colophon open
```

Progress goes to stderr and is concise: preflight, sample preparation, two arms, report, local publication, copied-bundle verification. There is no spinner-only state; long steps show the current arm/cell and elapsed time without inventing an ETA.

### 5.3 The aha moment

Installation is not the aha. “A process exited successfully” is not the aha either. The first-run report must make three recognitions happen in order:

1. **Comparison:** “These two configurations faced the same three tasks, and their measured outcomes are visible cell by cell.” The current `wilson@1` sample does not register a comparative winner, so every headline remains neutral even if descriptive arm scores differ.
2. **Explanation:** “I can click a cell and see the task input, each arm's output, the score evidence, and why the aggregate changed.” The first screen is a two-arm by three-task matrix, not a wall of lifecycle logs.
3. **Ownership and trust:** “The report and evidence are mine, on disk, and another person can re-derive the claim.” A visible `6 / 6 checks passed` panel names the six checks, links each to the evidence it used, shows the absolute bundle path, and gives the reader-only command.

The headline is therefore specific and bounded:

```text
Complete comparison on 3 sample tasks. No comparative winner stated.
6 of 6 bundle checks passed. Nothing was uploaded.
```

The report then offers one primary next action, **Use my work**, and two secondary actions, **Open the evidence** and **Copy verification command**. “Use my work” opens the local workspace journey; it does not ask for an account, email address, API key, or upload.

### 5.4 Local UI journey

The UI is local-only, not a hosted service. The sample starts the packaged viewer against one fixed retained bundle; the viewer re-runs verification server-side and labels that live result separately from the immutable bundle. The workspace UI binds to loopback and reads its fixed local workspace. Neither sends telemetry, has account state, or makes publication mean upload.

At the packaged-sample increment, the viewer supplies the comparison matrix, cell drill-down, trust/limitations panel, live six-check result, bundle path, and next actions. `colophon open --bundle <path>` opens the same read-only mode; browser requests cannot select another host path.

The later own-work target is `colophon open`, a local home with three choices:

- **Run the sample** — one action drives the same zero-key demonstration through local publication and opens its verified result;
- **Verify a bundle** — choose a local path and run the reader checks;
- **Use my work** — select tasks, choose two supported arms, review requirements, run, inspect, and publish locally.

“Use my work” is a guided projection of the explicit lifecycle rather than a second workflow. It asks for a task source first, then two arms. Before method lock it runs `doctor` and shows, in plain speech, Docker requirements, agent-login requirements, possible provider charges, network use, disclosed configuration, and the exact benchmark size. The user reviews the locked method before any paid agent call. During execution the UI shows the live arm-by-task matrix and makes interruption/resume explicit. Completion returns to the same comparison, evidence, and portable-verification aha as the sample.

### 5.5 What Colophon borrows from Harbor

Harbor's primary surface is one `harbor run` command. It writes a durable job directory and provides a local viewer for browsing jobs, comparing them side-by-side, drilling into trials, trajectories, verifier output, timing, and collected artifacts. That is the right usability pattern to borrow: one primary action, durable results, a matrix, and progressive evidence detail.

Colophon does not copy Harbor's hosted Hub, account/upload path, usage statistics, cloud-sandbox posture, or product record model. Its distinct aha continues past inspection: a comparison becomes a locally published bundle that a reader can verify independently.

Harbor is a later **runtime adapter**, not a new Colophon importer or canonical record kind. A Harbor Trial can contribute attempt evidence and a managed Job can be published post-hoc through the product-neutral accounting/publication profile. A Harbor Job is not a Colophon Run, arbitrary historical Jobs do not earn synthesized provenance, and a Harbor retry that starts work is a visible Colophon dispatch rather than salvage under one Submission. Terminal-Bench 2.1 locks maintainer `retry.max_retries: 3`; TB 2.0 keeps `0`. The first UI can borrow Harbor's interaction model before the adapter ships; it must not advertise Harbor execution until that conformance path exists.

Borrowing Harbor's interaction model is not "you run Harbor." When the Harbor adapter is advertised, it is a **trial engine under a Jinn lock** ([DR-2026-08-17](../log/decisions/2026-08-17-runtime-engine-direct-mode.md)). Do not promise that Hub placement is the Colophon claim, that one `harbor run` is the Colophon Run, or that last week's foreign job can be imported.

**Official suite vs select-a-task.** Terminal-Bench 2.1 is a **named protocol** Colophon wraps: lock the official dataset pin, k=5 planned trials, official env, and named coverage, then run Harbor under that lock ([DR-2026-08-17-b](../log/decisions/2026-08-17-official-suite-protocol.md)). Direct-mode grain for that protocol is one Harbor Job per arm spanning selected tasks × planned trials; each Trial binds to a pre-sealed cell as it starts. Hub export is a derived Harbor-shaped artifact of that accounted run, not the claim of record, and must not be offered as a leaderboard submission unless `leaderboard_submit_ready` after collect (every dataset task × 5 judged or Harbor-error 0, ATIF bytes on the retained job). Inspect remains “select a supported Inspect task” — Colophon expands it into a locked comparison and runs each cell through Inspect. The TB 2.0 one-task path stays and cannot wear the 2.1 suite name. A cousin method on official-suite tasks cannot wear the suite name.

### 5.6 From the sample to “my tasks, my arms”

The user may install the same package for repeated use:

```sh
npm install --global @colophon-claims/cli@1
colophon open
```

The existing explicit lifecycle remains the advanced truth: create a draft, import tasks, add at least two arms, preflight, quote, lock, launch/resume, collect, report, verify, and publish. Self-serve adds a guided path and declarative files; it must not hide method locking or make a report look complete before the evidence exists.

A representative supported path is:

```sh
colophon import swebench --draft <draft-id> --file ./tasks.json
colophon agent add --agent codex-low --adapter codex \
  --model <exact-model-id> --effort low
colophon agent login --agent codex-low
colophon arm add --draft <draft-id> --arm codex --agent codex-low
colophon doctor --draft <draft-id>
colophon quote --draft <draft-id> --ack-provider-network-costs
colophon lock --draft <draft-id> --ack-provider-network-costs
colophon launch --draft <draft-id> --ack-provider-network-costs
colophon collect --draft <draft-id>
colophon report --draft <draft-id>
colophon publish --draft <draft-id>
```

This is illustrative grammar, not an instruction to rename already-shipped operations. The implementation issue must reconcile it with the current CLI and keep aliases/migrations explicit.

#### Task intake that earns a public surface

For the first runner release:

- the bundled sample remains the zero-dependency proof;
- `colophon import swebench` remains the first coding-task importer because it is implemented, strict, recognizable, and aligned with the current coding beachhead;
- the existing Inspect selection path is supported for users who already own an Inspect evaluation, but is described as a runtime/evaluation integration rather than pretending to be a general task importer.

No generic CSV, arbitrary JSON, GitHub-Issue, or domain-specific importer is added speculatively. Harbor also does not enter as a generic importer: it is an execution backend for a Jinn-managed benchmark plan. A new importer earns a public surface when at least two qualified campaigns repeat the same manual transformation and can name the benchmark they will run and the date they will run it. The next likely candidate is a narrow repository-work manifest for tasks that do not have SWE-bench's transition semantics; it is not part of v1 until that evidence exists.

### 5.7 Cold-machine failure contract

Failure happens before expensive or destructive work whenever possible. Every refusal gives: what was checked, what was found, what the user must do, and whether anything was created.

| Condition | Required behavior |
|---|---|
| No Node/npm | The site states “Node 22 or newer is required” beside the command and provides a plain install link. A shell-level `npx: command not found` cannot be improved by the package, so the prerequisite cannot be hidden below the fold. |
| Wrong Node | `engines` rejects unsupported installs and the executable performs an immediate version check: “Colophon needs Node 22 or newer. Found Node X at PATH. No benchmark was started.” |
| Unsupported OS/architecture | Refuse before unpacking/running native helpers. Print the qualified release matrix and link the contributor flow; do not silently fall back to an unverified process-control path. |
| Missing packaged asset/native helper | Treat this as a broken distribution, print package version and expected asset, and ask for a bug report. Never fetch an unpinned helper at runtime. |
| No Docker | The sample and reader verifier continue because neither needs Docker. OCI Inspect selection refuses before method lock when the Docker CLI is missing or its engine is stopped, tells the user to install/start Docker, and explains that Docker may execute untrusted task material. |
| Missing agent executable | `doctor` names the selected adapter and searched path, then shows the exact configuration command. No benchmark is locked or launched. |
| Agent not authenticated | `doctor` says which local agent login is missing and that real harness runs may make paid provider calls. It never prints credential contents. |
| Unwritable, occupied, or linked output | Resolve and validate the target without following an attacker-controlled link, refuse without overwriting, and print how to choose another path. |
| Interrupted run | Preserve the owned workspace and print the exact resume command. The one-shot sample may clean only disposable staging after its output copy is durable. |
| Verification failure | Preserve the bundle unchanged, exit non-zero, name the failed check/path, and never print “verified” or a partial success headline. |

The v1 zero-Docker release matrix is **Ubuntu x64 and Apple-silicon macOS arm64 with Node 22**. Both targets run the same clean local-registry proof: resolve the public `@1` selectors, install real tarball directories, run and retain the sample, independently reverify and reject a tampered bundle, and serve the verified report from a loopback-only viewer. The package embeds this exact matrix rather than inferring support from its build host. Windows and Intel macOS remain unsupported until separately qualified. This matrix does not qualify Docker/Inspect or provider-agent execution; those paths retain their own `doctor`, runtime, credential, and cost gates.

## 6. Install and distribution decision

### 6.1 Candidate comparison

| Candidate | Cold-user value | Mono/release fit | Main costs and hazards | Decision |
|---|---|---|---|---|
| One top-level npm CLI over published stable Jinn packages | One product install and normal npm upgrades; preserves the real stack package boundaries | Good once the required platform set is published. Colophon can remain on one exact stable set across product-only releases | Stable-platform precondition, dependency graph size, exact-version discipline, broken/partial stable cuts | **Winner for v1** |
| Fully bundled single npm CLI | Also gives one user command and can work before every dependency is published | Technically workable, but creates a second compiled distribution boundary over many independently governed packages | Bundler/dynamic-asset failures, license inventory, harder platform vulnerability updates, risk of obscuring architecture | Contingency only if the stable-package assumption is false |
| Scoped family as the user surface | Lets expert consumers select platform pieces | Poor product UX even after publication | Makes users coordinate internal packages and turns architecture into onboarding | Reject; platform packages are dependencies, not Colophon install instructions |
| `npx` one-shot | Lowest-commitment first run and exact/major version selection | It is the invocation surface for the npm CLI, not a separate artifact | Requires Node/npm; initial registry download; package-name/publisher trust must be clear | **Winner for first-run invocation** |
| Standalone binary | Removes Node/npm and can make reader verification truly single-file | Weak today. The runner assumes Node subprocess behavior and packages JS, fonts, native helpers, optional Python/Inspect and Docker assets | Per-OS/architecture builds, signing/notarization, native containment, update/provenance path, larger QA matrix | Defer; promote if Node is a measured blocker |
| Devcontainer | Reproducible environment for Docker-heavy tinkerers and contributors | Does not remove the mono build or image release problem by itself | Requires Docker and a large pull, contradicts the zero-Docker sample, poor reader-verifier surface | Defer as an advanced fallback |

The winner is therefore **one Colophon npm runner plus a smaller verifier, both consuming a coherent published Jinn platform set, with no-argument `npx` as the first-run surface**. “One package” describes what the visitor chooses, not a claim that npm installs only one physical dependency.

### 6.2 Required package boundary

All product code is Colophon-owned Tier 4 code. `@colophon-claims/core` owns the canonical operations and product composition, `@colophon-claims/cli` is the thin executable/install surface over it, and `@colophon-claims/verify` owns the independently installable reader path. The private `@colophon-claims/web` source package is built into the local CLI distribution; it is not a fourth public install choice. No benchmark-product package publishes under `@jinn-network/*`.

The runner package must contain:

- compiled Colophon application code;
- Colophon-owned report fonts and static assets;
- product-owned sample data and subprocess arms;
- package version, source commit, license/notice inventory, and supported bundle-format metadata.

It declares the smallest stable `@jinn-network/*` dependency closure required by the advertised commands. Each direct dependency is an exact version from one coherent platform release, and the published shrinkwrap/release receipt freezes the resolved transitive graph. Jinn sibling packages in that graph must themselves be public, have built `dist/` and declared assets in their tarballs, and be mutually compatible. The public v1 runner remains a local-only product profile; it does not expose marketplace/network venue operations merely because the mono contains them.

It must not:

- install a compiler or build workspace packages on the user's machine;
- fetch executables, fonts, schemas, or scripts from mutable URLs at runtime;
- use `workspace:`, Yarn portal/link protocols, local tarballs, the floating `canary` dist-tag, mixed canary SHAs, or unpublished Jinn packages in a release candidate (exact `0.1.0-canary.sha.<fullSha>` pins from one receipt are allowed for the first public cut only; [DR-2026-08-17-c](../log/decisions/2026-08-17-colophon-first-cut-canary-pin.md));
- expose unrelated platform commands because code happened to be bundled;
- turn optional Docker/Python integrations into prerequisites for the sample or verifier.

Packaging is not architectural vendoring. Colophon imports the canonical tier-1–3 packages and their guards; it does not copy their source, schemas, or fixtures into product-owned implementations. A deployment graph may span several tiers, but the source dependency direction and behavior rules remain intact.

The current workspace-order CI remains useful for mono development, but it is not the release proof. Its package build order is verifier, core, private web build input, then CLI: the CLI tarball embeds the private web output while `@colophon-claims/web` remains neither a public package nor a CLI runtime dependency. The Colophon release proof packs the product, starts in a clean directory with a cold npm cache, installs only from the configured public registry, checks that no workspace/local resolution survived, and runs the packaged sample/verification tests. A workspace test or local-tarball consumer test is not evidence of distributability.

The verifier follows the same rule but declares only the product-neutral record/facts dependencies needed for bundle parsing, evidence-closure derivation, trust/claim/report checks, plus Colophon bundle projection, required report assets, and CLI/error handling. Product verifier code that currently imports execution-oriented modules must be cut at a public verification boundary rather than dragging the runner, launcher, local backend, Docker, or Python/Inspect closure into the reader artifact. The full runner and reader package must execute the same verification implementation.

Normative schemas and fixtures remain owned and published by the product-neutral stack packages. Live `spec.jinn.network` availability remains the standing precondition to calling Increment 1 a complete independent-implementer proof. For the first public cut, npm-published platform tarballs at the pinned canary versions are the retrievable bytes, and the missing live origin must be disclosed ([DR-2026-08-17-c](../log/decisions/2026-08-17-colophon-first-cut-canary-pin.md)). Increment 1 publishes the tier-4 public-bundle format/vectors separately and proves the Colophon reference verifier against both layers. The reader may install or package the exact released platform bytes for offline use, with their independent identity and source preserved; it may not fork or relabel them as Colophon schemas. Product-level bundle vectors stay visibly separate and may name Colophon.

### 6.3 Relationship to `@jinn-network`

The platform source remains in `@jinn-network/*` packages inside the mono, and those packages publish under the Jinn-Network scope. Colophon consumes those published packages as ordinary dependencies (exact first-cut canary versions, then stable) and continues to say “Built on Jinn, by Jinn contributors” where the GTM program requires that relationship line. The public install contract is nevertheless the Colophon endpoint package and bundle format; users are not asked to assemble or version the platform themselves.

This separates product and platform identity without hiding either one:

- **npm publisher shown for the product:** the Colophon-controlled organization;
- **runtime platform dependencies:** `@jinn-network/*` at one coherent release set (stable after the first cut; exact stack-canary versions for that first cut only);
- **public product face:** `ritsukai` and `colophon.claims`;
- **source and Issue source of record today:** the Jinn-Network mono and exact package directory;
- **attribution:** “Built on Jinn, by Jinn contributors.”

Colophon does **not** silently claim the existing `@colophon` scope. On 2026-08-13, unscoped `colophon` and `@colophon/cli` are already published by unrelated projects. A new Colophon-controlled scope would need a distinct, verified name.

### 6.4 Colophon npm identity — accepted, publication controls still required

The selected direction is `@colophon-claims`, a new Colophon-controlled organization rather than Jinn or a personal npm scope. Public packages are `core`, `cli`, and `verify`; `web` remains private build input. The scope matches `colophon.claims` and the checkable-claims promise and is distinct from unrelated generic packages.

Registry lookups returned no package for those exact package paths on 2026-08-13, but an `E404` is not proof that the npm organization name can be created or that the identity is safe to adopt. Reservation is a human publication prerequisite.

The operator decision must record all of the following together:

1. npm organization/scope and exact package names;
2. who owns and can recover the publisher identity;
3. which GitHub identity/repository the npm metadata points to;
4. whether product-only Colophon releases may use a separately approved, demand-gated tag/workflow between Monday platform cuts;
5. the public attribution line and how `ritsukai`, Jinn-Network, and “Built on Jinn, by Jinn contributors” relate;
6. where vulnerability reports and package ownership changes go.

No package publication proceeds on an assumed answer.

### 6.5 Release cadence and repository location

The minimum viable source arrangement is the current mono plus a product-specific artifact workflow:

- source and Issues stay here;
- a Colophon release resolves one reviewed source commit;
- CI installs the exact stable Jinn platform set from the public registry rather than building workspace siblings for the release proof;
- each endpoint tarball is produced, cold-installed with its resolved dependency graph, tested, receipted, and provenance-attested;
- publication is manual/demand-triggered, not automatic on every integration push;
- the release tag namespace is product-specific;
- no version change to workspace siblings is required merely to ship Colophon.

Colophon may remain on one stable Jinn set across several product releases. Whether the mono workflow may publish those product-only releases between Monday cuts still depends on the operator/handbook decision above. A separate npm organization removes identity coupling; it does not silently grant a release-policy exception.

Repository options remain:

1. **Stay in the mono — recommended initially.** Lowest work and one source of truth. The package points to the exact mono path and commit.
2. **Automated read-only published mirror.** Useful if readers need a product-shaped source/release page under the public Colophon identity. It must be generated from immutable mono tags, refuse direct changes, and link issues back here. It improves discovery, not technical independence.
3. **Independent source repository.** Reconsider only after extraction gates are green and repeated release or contribution demand justifies dual governance. This can truly decouple CI/release ownership, but it is not a packaging shortcut.

A mirror or extraction review is triggered when any of these becomes true:

- two needed Colophon product releases are blocked between two consecutive Jinn Monday cuts;
- external contributors repeatedly arrive through the Colophon identity and cannot navigate the mono contribution boundary;
- package consumers require a product-specific security/release page for adoption;
- the extraction readiness gates are green and mono-bound release governance is the dominant release cost.

Until then, a new repository creates more provenance and source-of-record risk than value.

## 7. Bring your own agent

### 7.1 Minimum public arm surface

The sample arms remain toys. Public self-serve v1 supports exactly two real harness adapters first:

- Claude Code;
- Codex.

Those are already represented in the platform launcher surface and match the coding beachhead. Supporting them means product-owned configuration, preflight, identity capture, auth isolation, and result handling—not merely exposing a generic subprocess field.

The minimum arm definition is a strict, versioned document shaped conceptually like:

```json
{
  "format": "colophon-arm/1",
  "armId": "codex-gpt-5.6-high",
  "adapter": "codex",
  "executable": {
    "path": "/absolute/path/to/codex",
    "sha256": "<observed executable digest>",
    "version": "<observed CLI version>"
  },
  "model": "<exact model>",
  "effort": "high",
  "loadout": {
    "instructions": ["./AGENTS.md"]
  },
  "network": "provider-required"
}
```

This example describes the evidence, not a promise of these exact field names. The CLI should normally probe and write the observed executable digest/version rather than asking a user to calculate them. A declarative file makes review and reruns possible; shorthand flags compile to the same strict record.

The public surface permits only:

- a named built-in adapter;
- an explicit executable selected by path and observed identity;
- exact model/effort and adapter-supported options;
- a bounded, digestible loadout;
- a declared network/cost class;
- parser and terminal-result behavior owned by the adapter.

The executable path is a host locator, not evidence identity. The observed digest/version and the existing run-pinning vocabulary are what enter the reviewable definition and, where the benchmarking contract permits, the sealed Submission requirements. The product configuration must compile to existing Benchmark/Run/Submission fields and namespaced extension slots; it does not add Colophon fields to tier-1–3 records.

It does not permit an arbitrary shell string, arbitrary environment forwarding, a user-supplied result parser, or task-controlled credential mapping. Those surfaces are difficult to quote, reproduce, secure, and explain.

### 7.2 Authentication and provider cost

Secrets are host grants, never arm definitions and never bundle contents. V1 supports both a protected API-key file and a one-time Colophon-owned harness login. It never copies the user's ordinary Claude or Codex home. Each built-in adapter uses the local backend's existing two-phase provisioner and reference-only secret-forward contract:

- is created or selected explicitly by the operator;
- is materialized by the provisioner into the attempt's `secrets/` area and reaches the launcher only as a declared reference, never as a value in a journaled launch plan;
- is absent from the sealed Task, Submission pinning, public arm definition, and bundle;
- is not printed, hashed into public records, or retained in the public bundle;
- is wiped at terminal under the backend contract.

The backend never originates, persists, or infers the grant. The product decides which configured grant a run may use; the launcher plans; the supervisor resolves the declared reference at exec. If Claude Code or Codex requires a credential-bearing file in durable `harness-state/`, that adapter is **not qualified for self-serve** until it can keep the credential in the terminal-wiped secret boundary. Durable harness state and transcripts are not a secret store.

Machine-local agent profiles and credential references live in the OS user-data directory, outside the workspace and repository. `colophon agent credentials` records a protected key-file grant; `colophon agent login` creates a credential-only artifact using a supported harness login surface. A pinned harness version advertises a login mode only after qualification proves fresh attempt state, terminal wiping, disabled customization/telemetry where supported, and no credential bytes in durable outputs.

`colophon doctor` proves the executable, version, supported adapter settings, and credential readiness before method lock or launch. It makes no paid provider call and distinguishes “configured” from “provider accepted.” The CLI's SWE-bench path delegates to the existing product-neutral `benchmarking/interop` capability; Colophon does not grow a second importer implementation. Before a real arm runs, plain speech states:

```text
This arm uses your existing <provider/agent> login and may make paid provider
calls. Colophon does not create the account, hold funds, or pay those charges.
The published bundle will identify the harness and disclosed configuration,
but will not contain your credentials.
```

The current launcher isolation means “use my already logged-in CLI” is not free: Colophon must map an explicit local grant into the existing provisioner/launcher contract and prove that no secret value is written by Colophon into the Task, journal, durable harness state, transcripts, or public bundle. Passing the caller's whole home/config directory or ambient environment is not acceptable. The backend contract itself does not change for this product seam.

That control does not prove a harness will never echo a credential. The local-backend design names transcript leakage as a residual. Before a real authenticated adapter qualifies for public self-serve, Colophon must either apply product/evidence-side scrubbing for known forwarded values before publication or exclude credential-bearing raw logs/harness state from the public closure and fail closed when absence cannot be established. This is product publication policy above the backend, not a new backend guarantee.

### 7.3 Concierge-only surfaces

These remain concierge-only until repeated evidence justifies a narrow adapter:

- arbitrary subprocess commands or custom launchers;
- Hermes, Cursor, or other harnesses not yet demanded by two qualified campaigns;
- custom credential/secret injection;
- remote, distributed, or multi-machine agents;
- custom parsers and nonstandard result contracts;
- bespoke container images, graders, or non-coding domains;
- provider-account setup and budget policy.

Concierge work should produce reusable adapter evidence, not a universal plugin API by default. A public adapter earns its place when two campaigns repeat the same binding and a third user could configure it without the original operator.

## 8. Site quickstart contract by increment

The site consumes shipped capability. This spec does not authorize edits to `colophon-claims/site`.

### Increment 0 — current contributor proof

Keep the current source-build instructions and label them honestly:

> **Run the public proof from source**
>
> Clone the Jinn mono, use Node 22 and Yarn 4, build the required workspace packages, then run `yarn public-quickstart` from `packages/benchmark-product/core`.
>
> The sample needs no account, API key, or funds. It runs two bundled local arms and verifies a copied bundle. This is currently a contributor setup, not a packaged install.

Do not call this a one-command install. Keep a link to the exact build order.

### Increment 1 — reader verifier ships

Add a distinct reader action; leave the runner section source-based:

> **Check a Colophon bundle**
>
> You do not need the benchmark runner. With Node 22 or newer:
>
> `npx @colophon-claims/verify@1 ./bundle`
>
> The verifier reads the bundle on your machine, uploads nothing, and needs no account, API key, funds, Docker, agent login, or full Jinn checkout. It checks integrity, evidence closure, trust disclosures, calculations, report verification, and claim consistency.

The exact six-check result and trust caveat appear below the command. The site changes only in the release that publishes and cold-tests the verifier.

### Increment 2 — packaged sample runner ships

Replace the contributor command as the primary “Run it yourself” action:

> **Publish a sample bundle on your machine**
>
> Requires Node 22 or newer:
>
> `npx @colophon-claims/cli@1`
>
> No account, API key, funds, or Docker are needed. The sample does not use your agent logins. It runs locally, opens a local comparison, leaves a verified bundle in the current directory, and uploads nothing.

Keep “Build from source” as a secondary contributor link. State the qualified operating systems next to the prerequisite, not in an FAQ.

### Increment 3 — supported own-work path ships

Add “Use your tasks and agents” only when the relevant adapter/importer is released:

> Run `colophon open`, choose **Use my work**, import SWE-bench tasks, select a supported Inspect task, or lock a named Terminal-Bench 2.1 protocol (including a protocol-faithful slice), then compare Claude Code and Codex through pinned arm definitions. Colophon checks the machine and shows the locked method and comparability bits before any paid call.
>
> Real agent arms use your existing agent logins and may make paid provider calls. Docker is required only for task/evaluation paths that say so. Colophon has no account, holds no funds, and does not upload your benchmark bundle.

Do not name an adapter or importer on the site before its clean-machine path is supported.

## 9. Demand-gated increment map

Signals are recorded manually from concierge engagements, direct reader replies, and GitHub issues/discussions. There is no telemetry or covert measurement.

| Increment | Audience and problem | Smallest shippable work | Start trigger (any one is enough) | Site change |
|---|---|---|---|---|
| **0. Honest source proof** (current) | Contributors can prove the lifecycle; cold visitors cannot install it | Keep current quickstart/CI proof green and label it as source-based | Already true | Contributor copy only |
| **1. Reader verifier** | Report readers cannot check a bundle without the full product closure | Accept/reserve Colophon scope and identity boundary; publish the Colophon public-bundle format/vectors as a tier-4 contract; cut one verifier-only npm reference package over the minimal Jinn verification set (first cut: exact stack-canary pin per DR-2026-08-17-c); establish its demand-gated trusted release lane; cold-install against both platform and product contracts | One target reader declines or fails verification because a mono/full-runner install is required; **or** two independent readers ask for a copyable verification path after receiving a report | Add “Check a bundle”; runner stays source-based |
| **2. Packaged sample runner** | Repo tinkerers face the 23-distribution build chain and the current sample retains no artifact | Publish one top-level runner over the same first-cut Jinn pin; package product assets/sample; persist copied bundle/receipt; open the retained local comparison; preflight supported platforms; cold-registry `npx` test | Two independent repo tinkerers attempt the source quickstart and one is blocked by setup; **or** one converted concierge customer commits to rerun by a named date without operator help | Make no-argument `npx @colophon-claims/cli` primary; retain source link |
| **3. Own tasks and real agents** | Converted users can run toys but not their own harnesses safely | Local `colophon open` home and guided locked lifecycle; product-owned Claude Code and Codex arm schema/adapters over the existing provisioner/secret-reference contract; `doctor`; SWE-bench and qualified Inspect path; plain cost/network disclosure | Two qualified users who completed or attempted the sample request the same real adapter with named tasks and run dates; **or** two concierge campaigns repeat the same adapter binding and one asks for self-rerun | Add supported tasks/agents copy and cost/Docker disclosure |
| **4a. Advanced environment** | Docker-heavy users repeat setup failures | Versioned devcontainer for supported OCI/Inspect path | Two qualified campaigns lose a run to the same host/Docker setup gap | Add advanced container setup; never replace zero-Docker sample |
| **4b. No-Node distribution** | Qualified readers/tinkerers will not or cannot install Node | Standalone signed binary for the measured OS/architecture; preserve verifier conformance | Two qualified adoptions are blocked specifically by Node/npm, or the operator can no longer reach the target reader role with a Node prerequisite | Offer binary beside npm; do not silently switch |
| **4c. Public repo boundary** | Mono cadence/discovery becomes the dominant release cost | Automated immutable mirror first; independent repository only after extraction gates and a decision record | Two needed off-cycle releases between Monday cuts; repeated contributor discovery failure; or extraction gates green plus material release cost | Point source links to the chosen public boundary |

These triggers still govern publication and future work. The operator explicitly
overrode the start triggers for local implementation of Increments 1–3 on
2026-08-13; no Issue or Friday-routing metadata is required for that work.

## 10. Authorized pre-publication implementation

The operator authorized implementation in the mono without filing GitHub Issues. Local tarballs and an ephemeral registry remain valid pre-publication proofs. Public npm publication of the first Colophon cut is now authorized under [DR-2026-08-17-c](../log/decisions/2026-08-17-colophon-first-cut-canary-pin.md), after stack canary exists and `@colophon-claims` is reserved. Site mutation is still a separate gate.

### 10.1 In scope

1. Establish the public-shaped Colophon package family and executable ownership,
   while using local portals only as a development bridge until Jinn packages are public.
2. Move the six-check reader into `@colophon-claims/verify`, keep the full
   product on that same authority, and prove its packed standalone behavior.
3. Retain the bundled sample, copied bundle, receipt, and next steps; verify the
   copy after source-workspace deletion and open a loopback-only verified viewer.
4. Implement the `colophon` endpoint, early Node preflight, actionable cold-host
   failures, headless/JSON operation, and the existing advanced lifecycle delegation.
5. Implement a product-owned declarative Claude Code/Codex profile seam over a
   product-neutral reference-only credential grant boundary. Support protected
   API-key files and qualified Colophon-owned login artifacts without copying
   normal user homes or making a live provider call in tests.
6. Package the existing private web source as the local guided UI where feasible;
   keep every human action on the same core operations boundary.
7. Update source-boundary, inventory, packed-type, build-order, secret-absence,
   golden, tamper, and local cold-install tests for the new family.
8. Test with local tarballs or an ephemeral registry as far as possible, and
   record the exact point where unpublished public Jinn packages remain the gate.

### 10.2 Out of scope

- any public npm publication or scope reservation on the operator's behalf;
- live provider calls or paid test runs;
- new product-neutral record kinds, a generic plugin API, or a Harbor adapter;
- adding Docker or Inspect as a prerequisite for the zero-credential sample;
- a standalone binary, devcontainer, mirror, or repository extraction;
- edits to `colophon-claims/site` before the verifier actually ships;
- automatic canary publication on every integration push.

### 10.3 Implementation exit proof

Before handoff, every locally testable package builds and typechecks on Node 22;
the retained sample and verifier tests pass; a tampered bundle fails; the reader
closure excludes the runner/backend/launcher; the credential seam carries only
references in durable plans and no secret in receipts or public artifacts; and a
clean local package consumer can install the locally packed family without a mono
source import. Any proof that specifically requires public Jinn packages remains
an explicit blocked release gate, not a simulated success.

Publication remains held until demand, registry identity/custody, platform
publication, and release-policy gates are satisfied. Zero-Docker sample, reader,
viewer, and CLI qualification is implemented for `linux/x64` and `darwin/arm64`.

The implemented pre-publication seam supports protected API-key grants for both built-in
adapters and a protected credential-artifact storage/runtime path. The prepublication allowlist
admits the operator's exact Mac build candidates: Claude Code 2.1.222 uses a fresh `setup-token`
boundary and Codex 0.147.0 uses a fresh `CODEX_HOME` device-auth boundary. Admission binds adapter,
observed version, and executable digest; every other build fails closed. Colophon never reads or
copies the normal Claude or Codex home. Automated tests qualify isolation, validation, cleanup,
and storage with injected login runners. Section 10.5 records the later real interactive capture and
one-cell provider acceptance; wider model/task efficacy and public support remain separate gates.

The local-registry proof also installs the reader alone and refuses any resolved Colophon
runner/core or task-execution backend, launcher, supervisor, or workspace package. To make that
installed boundary true, `benchmarking-run` now exposes the narrow structural quote/dispatch port
it consumes instead of imposing its full execution-backend package on verification-only users.
Concrete TEP backends remain structurally compatible.

### 10.4 Aha-gap repair implemented 2026-08-14

The reader package now owns a bounded human comparison projection derived only after the six
verification checks have authenticated the Benchmark, Matrix, assembly, and content-addressed
record closure. It projects task labels, arm outputs, ordered verdict evidence, score direction,
and a descriptive paired count; it never registers a winner. For the bundled sample it also says
that the outcome is synthetic and the result demonstrates the evidence path rather than agent
quality. Core re-exports the reader's deterministic asset builder instead of carrying a second
copy.

New bundles render that projection ahead of raw accounting. The reader remains compatible with
pre-projection bundles by requiring one complete deterministic asset profile: it accepts the
complete legacy projection when every legacy asset matches, otherwise it requires the complete
comparison projection. It never accepts a mixture. The verified viewer renders the same
authenticated comparison from its immutable byte snapshot, offers cell evidence, and exposes
**Use my work**, **Open the evidence**, and **Copy verification command**. Starting the guided
workspace is an explicit one-time browser action and shares the viewer's shutdown boundary.

`colophon open` now lands on the three-choice local home: **Run the sample**, **Verify a bundle**,
or **Use my work**. The own-work path starts with a named comparison, then presents sample or
file-based SWE-bench intake and configured Claude Code/Codex profiles before the existing doctor,
cost/network disclosure, quote, and lock gates. Raw draft, Arm, Inspect, authority, and publication
controls remain available as advanced surfaces. No live provider or paid execution was performed
as part of this repair.

The Mac release proof cold-installed the three public tarballs through real `@1` selectors, ran
and retained the sample, served its task-by-task viewer, independently returned the canonical six
checks, and rejected tampering. The production Chromium suite exercised the packaged one-time
loopback server and complete local lifecycle. CI artifact transport now includes hidden files so
the packaged `.next/BUILD_ID` reaches clean macOS qualification.

The repaired production-browser journey additionally proves both user-facing aha paths. One
action on the local home reaches a published verified report and then rechecks that bundle through
the reader form. The own-work path names a comparison, imports a real three-row SWE-bench file,
selects two ready low-effort Claude Code/Codex profiles, refuses quote without the provider
network/possible-charge acknowledgement, and reaches a locked method after acknowledgement. The
test profiles use inert executables and a sentinel grant; no provider is contacted.

On the operator's Apple-silicon Mac, the installed Claude Code 2.1.222 and Codex 0.147.0 binaries
were also passed through the real `agent add` surface. Colophon resolved the Codex npm shim to its
native executable, observed both versions, stored their exact digests and low-effort exact model
IDs, and created no credential files at that setup checkpoint. Section 10.5 records the later
interactive login and quota-consuming acceptance runs.

Docker Desktop acceptance on the same Mac built the pinned `linux/amd64` Inspect worker and ran
the real multi-scorer OCI lifecycle: two arms, hosted sandbox, native Inspect logs, separate
evaluation records, sealed Report, six-check verification, detached copied-bundle verification,
official native-log reading, generated Inspect viewer, and no retained Colophon containers. This
is local acceptance evidence for the advanced path, not an expansion of the zero-Docker npm
release matrix.

The only distribution proof deliberately left for last is the real public-registry install. The
local-registry proof uses real tarballs, an empty npm cache, actual `@1` selectors, a recursively
audited reader closure, the installed viewer-to-workspace handoff, tamper refusal, and no portal or
source-tree paths. Public npm still depends on scope custody and one coherent stable published
Jinn dependency set.

### 10.5 Cheapest-capable runtime and live provider acceptance — 2026-08-14

The v2 Demo-1 runtime policy starts at the cheapest qualified configuration rather than assuming
that a stronger model is required. Its frozen candidate ladder is Claude Haiku 4.5 low, medium,
then high effort, followed by Claude Sonnet 5 low effort. `claude-haiku-4-5-20251001` is a dated
snapshot; Anthropic documents the post-4.6 `claude-sonnet-5` identifier as a pinned snapshot even
though it is dateless. The accepted v1 Haiku/high runtime remains unchanged and verifiable as
history.

Each candidate gets one complete 12-task suitability cohort. Two through ten valid passes selects
the candidate; fewer than two is a measured floor and advances exactly one rung; more than ten
changes the task band instead of buying a stronger model. Missing loader evidence, authentication
or launcher incompatibility, incomplete accounting, too few valid grader outcomes, excess
timeouts, or unresolved infrastructure stops inconclusive. Those conditions never become an
excuse to escalate. The policy and selection artifacts bind the decision digest, exact harness
version and executable digest, skill digest, task-pool digest, and explicit provider-call ceilings
(6 path-smoke calls, 12 per suitability candidate, 48 before human review, 200 for E2 rehearsal,
and 600 for the official run).

The operator then authorized a minimal paid acceptance on Apple silicon. Through the public CLI,
Colophon used the protected Claude login captured in its own data directory, sealed one public
SWE-rebench Conan task, pinned Claude Code 2.1.222 by executable digest, and selected
`claude-haiku-4-5-20251001` at low effort. Three pre-provider or post-process gaps were found and
fixed without rewriting failed evidence: ordinary Claude profiles were mistaken for Demo-1,
host-owned secret references were rejected by a requester-only validator, and ordinary
Claude/Codex repository edits were not harvested into the required patch output.

The final immutable run `bf400209e7721a6307fe53b5d845c3291080009551a826a586b25c4ad7f16513`
then completed both arms. The local baseline failed; the single Haiku-low solve spawned through the
credential bridge, returned provider usage, exited zero, and produced a 5,862-byte patch. The
pinned, network-disabled Docker grader judged that patch as passing. Colophon collected a complete
2/2 matrix, sealed the report, published bundle
`25b6b7af475937c9f0f731b615fab90456ba01416c3484aac6b33af3377f8396`, and the standalone
`@colophon-claims/verify` implementation returned all six canonical checks. The authenticated
loopback viewer returned the report and refused launch-token replay. This is provider-path and
product-lifecycle acceptance, not evidence that Haiku or the skill is generally better: one task
cannot support an efficacy claim.

Codex 0.147.0 was then accepted through the same one-paid-cell shape. Its direct device login
showed that this exact Codex release creates `log/codex-login.log` and a `tmp/arg0` helper tree in
the fresh isolated `CODEX_HOME` as well as `auth.json`. Colophon initially rejected those extra
artifacts and stored no credential. The final implementation permits only the bounded login log
and the exact private helper layout whose symlinks resolve to the qualified executable, rejects
every other artifact, copies only `auth.json`, and deletes the temporary login root. It never reads
the operator's normal Codex home.

The final immutable Codex run
`e3a0d9c1a40e3061a175e40f49a892ee40dae82af0ba7673fcd28093483e2d3f`
pinned Codex 0.147.0 by executable digest, exact model `gpt-5.6-luna`, and low effort. The spawn
record confirms those flags and the isolated credential bridge. The single provider turn completed
on its first dispatch with non-zero provider usage, exit zero, and a 2,035-byte harvested patch.
The same pinned, network-disabled Docker grader judged the local baseline as failing and the Codex
patch as passing. Colophon collected a complete 2/2 matrix
`c75c90c2bc04496e66fd6527b1ac087663cdbca880dc9df0f033bbc0fc98634d`, sealed the
report, and published bundle
`02d2c5a2e5e36c7ce2235b74469287971f27df9845098794036505999c1d0066`. The standalone
reader returned all six canonical checks; the authenticated loopback viewer returned the verified
report and refused launch-token replay; a boundary scan found no profile identifier, credential
reference, or login-artifact name in the bundle.

The Claude and Codex results are provider-path and product-lifecycle acceptance only. They do not
show that either model or any skill is generally better: each uses one task, and provider cost or
subscription settlement is not independently measured. The 12-task cheapest-capable suitability
cohort remains the first result-bearing model decision. Public-registry installation remains
deliberately last.

## 11. Risks and controls

| Risk | Control |
|---|---|
| A partial or drifting Jinn release makes Colophon installable but incoherent | Pin one platform set exactly (first cut: one stack-canary SHA); publish a resolved dependency receipt; cold-install only from the registry; fail release on workspace, local, floating `canary` tag, mixed SHAs, or out-of-set resolution |
| “One command” hides a large or unsafe dependency closure | Produce a dependency/file/license inventory; assert forbidden runner modules are absent from verifier; cold-install and inspect the resolved tree |
| Reader trusts npm publisher more than the evidence | Publish provenance/source binding and public format vectors; state what verification cannot prove; keep independent implementations possible |
| The verifier package itself becomes a supply-chain execution risk | No install lifecycle scripts; trusted publishing/provenance; exact package identity in bundle instructions; never execute bundle content; keep verification offline after install |
| Separate verifier drifts from full CLI | One source implementation and conformance corpus; every runner release tests equivalence against the reader package for supported formats |
| Colophon becomes the de-facto protocol specification | Publish product-neutral schemas/procedures/fixtures first; keep product names out of tier-1–3 artifacts; treat the CLI as a replaceable reference implementation |
| Packaging collapses tier boundaries or creates editable vendored platform code | Depend on the canonical published packages and keep architecture guards; reject product-owned forks of platform source |
| Package scope silently blurs `ritsukai`, Colophon, and Jinn-Network | Hard publication gate on the exact metadata/custody decision in section 6.4; show product publisher, source repository, platform dependencies, and attribution separately |
| Colophon needlessly rides every Monday platform cut | Hold one exact stable platform set across product-only releases; upgrade deliberately; do not infer an off-cycle policy exception from the separate npm organization |
| Real harness auth leaks into tasks or bundles | Product-selected grants through reference-only secret forwards; terminal wipe; no ambient env; product/evidence scrubbing or fail-closed exclusion of credential-bearing durable artifacts |
| “No funds” copy leaks from sample to real arms | Keep the claim adjacent to the sample only; real-arm copy says provider calls may be paid before launch |
| Users mistake local `publish` for upload | Always print “Published locally; nothing was uploaded” and an absolute bundle path |
| Product repo split creates two sources of truth | Stay mono-first; any mirror is immutable/generated; extraction requires green gates and a decision record |

## 12. Open decisions

The operator must decide before public package publication:

1. Reserve `@colophon-claims` and record who holds recovery and trusted-publisher authority.
2. Which repository, homepage, bugs, author, and attribution metadata express `ritsukai` as the public face, the Jinn mono as current source of record, and `@jinn-network/*` as the platform without implying they are the same identity?
3. May product-only Colophon releases use a demand-gated lane between Monday platform cuts, or do Rules 8–9 continue to gate them even though the dependency set is unchanged?

The v1 zero-Docker target decision is resolved: `linux/x64` and `darwin/arm64` are
qualified by target-specific cold-registry jobs. That decision does not widen the
qualification table for provider calls. The two named Mac executable identities above are the only
prepublication login-capture candidates and have completed the one-task provider-path acceptance in
section 10.5. Expanding the support claim to another build, platform, model, or task family requires
its own qualification evidence. Docker/Inspect retains its own local/runtime gates.

Later decisions are deliberately deferred:

- when a Node-free binary has earned its cost;
- whether reader verification also ships as WASM or another independently implemented form;
- whether recurring non-SWE-bench tasks earn a repository-work importer;
- whether demand warrants a published mirror or source extraction.

## 13. The load-bearing assumption

The assumption that most changes this design if false is: **the required Jinn packages will be available as one coherent, usable stable registry release before Colophon packaging starts**. If they are not, the thin Colophon packages cannot pass the clean-registry proof. Packaging should wait; if demand makes waiting unacceptable, the contingency is a fully bundled CLI/verifier with a larger provenance, security-update, and release burden.

The next UX assumption is that a qualified report reader or repo tinkerer can run Node 22/npm locally. If conversations show that Node is the actual adoption blocker, the signed standalone verifier moves ahead of npm. Both assumptions are tested through concierge follow-up and direct reader/tinkerer conversations, never telemetry.

## 14. Source references

- `PRINCIPLES.md`
- `BRAND.md`
- `docs/engineering/handbook.md`
- `docs/superpowers/specs/2026-07-30-stack-design-principles.md`
- `docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md`
- `docs/superpowers/specs/2026-07-28-benchmarking-application-design.md`
- `docs/superpowers/specs/2026-07-27-local-execution-backend-design.md`
- `docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md`
- `docs/spikes/2026-08-13-colophon-harbor-marketplace-publication.md`
- `.github/workflows/benchmark-product-ci.yml`
- `.github/workflows/stack-npm-publish.yml`
- `docs/superpowers/plans/2026-08-09-benchmark-product-extraction-readiness.md`
- `packages/benchmark-product/README.md`
- `packages/benchmark-product/PUBLIC-BUNDLE.md`
- `packages/benchmark-product/core/README.md`
- `packages/benchmark-product/core/package.json`
- `packages/benchmark-product/core/quickstart/public-quickstart.mjs`
- `packages/benchmark-product/core/src/branding.ts`
- `packages/benchmark-product/core/src/bundle/verify.ts`
- `packages/benchmark-product/core/src/intake/swebench.ts`
- `packages/benchmark-product/INSPECT-RUNTIME.md`
- `packages/benchmark-product/core/src/venue/venue.ts`
- GTM plan files named in section 3.3 at commit `54e1f4070`
- Harbor documentation: Getting Started, Core Concepts, Evals, and Artifact Collection, reviewed 2026-08-13
