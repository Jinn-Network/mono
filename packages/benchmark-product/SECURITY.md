# Colophon security and threat model

This note applies only to the incubating `packages/benchmark-product` Tier 4
product. It describes the local implementation shipped in this tree; it does
not expand the guarantees of the records, execution venues, or trust packages
the product consumes.

## Deployment status: none

There is no hosted service, deployed web application, remote account system,
or hosted authentication boundary today. The web app is a private local-process
client of the core operations library. The response headers documented below
are defense in depth for `next start`, not a claim that the product is safe to
place on the public internet. TLS, HSTS, proxy hardening, tenant isolation,
rate limiting, session authentication, and deployment operations remain
outside the implemented product.

Colophon's hosted account, billing, registry, and report screens are retained as
explicit read-only previews of the planned service. They carry no operational
forms, create no authority, and do not weaken this deployment boundary.

## Protected assets

- Mutable drafts, authority grants, audit and run journals, cancellation
  markers, and finalization/publication ownership records.
- Exact sealed record bytes and their content-addressed identities.
- Report and evaluator private signing keys held inside the workspace.
- Runtime configuration, subprocess arguments and diagnostics, environment
  values, and absolute filesystem paths.
- The immutable public-bundle closure, public trust keys, manifest, Report,
  claim package, and derived presentation assets.

## Trust boundaries

### Browser/server

The browser supplies product form fields and draft identifiers only. It never
supplies a workspace path or arbitrary bundle path. Server-only modules load
the public `@jinn-network/benchmark-product-core` entry and project typed,
minimal receipts. All error detail is treated as attacker-controlled because
filesystem and subprocess failures may contain paths, commands, or secrets.
The browser receives a fixed description for each error code and safe logical
issue paths. Every private response is `no-store`, frame-denied, same-origin
restricted by CSP, and protected by strict content-type, referrer, and
permissions headers. `base-uri 'none'` prevents base retargeting. Next.js currently requires inline bootstrap scripts and
framework/style output, so CSP admits inline script/style while denying
external origins, script attributes, objects, frames, and off-origin forms or
connections.

The `Permissions-Policy` allowlist is empty. It is version-pinned to Chromium
`147.0.7727.15` through Playwright `1.59.1`; the optimized runtime asserts both
that Chromium recognizes exactly the following finite list and that
`document.featurePolicy.allowedFeatures()` is empty. Chromium's Linux build
recognizes the 80 common entries below; its Darwin build additionally recognizes
and denies `bluetooth`:

`accelerometer`, `aria-notify`, `attribution-reporting`, `autoplay`,
`browsing-topics`, `camera`, `captured-surface-control`, `ch-device-memory`,
`ch-downlink`, `ch-dpr`, `ch-ect`, `ch-prefers-color-scheme`,
`ch-prefers-reduced-motion`, `ch-prefers-reduced-transparency`, `ch-rtt`,
`ch-save-data`, `ch-ua`, `ch-ua-arch`, `ch-ua-bitness`, `ch-ua-form-factors`,
`ch-ua-full-version`, `ch-ua-full-version-list`, `ch-ua-high-entropy-values`,
`ch-ua-mobile`, `ch-ua-model`, `ch-ua-platform`, `ch-ua-platform-version`,
`ch-ua-wow64`, `ch-viewport-height`, `ch-viewport-width`, `ch-width`,
`clipboard-read`, `clipboard-write`, `compute-pressure`, `cross-origin-isolated`,
`deferred-fetch`, `deferred-fetch-minimal`, `digital-credentials-get`,
`display-capture`, `encrypted-media`, `fullscreen`, `gamepad`, `geolocation`,
`gyroscope`, `hid`, `identity-credentials-get`, `idle-detection`,
`interest-cohort`, `join-ad-interest-group`, `keyboard-map`, `language-detector`,
`local-fonts`, `local-network`, `local-network-access`, `loopback-network`,
`magnetometer`, `microphone`, `midi`, `on-device-speech-recognition`,
`otp-credentials`, `payment`, `picture-in-picture`, `private-aggregation`,
`private-state-token-issuance`, `private-state-token-redemption`,
`publickey-credentials-create`, `publickey-credentials-get`, `run-ad-auction`,
`screen-wake-lock`, `serial`, `shared-storage`, `shared-storage-select-url`,
`storage-access`, `summarizer`, `sync-xhr`, `translator`, `unload`, `usb`,
`window-management`, and `xr-spatial-tracking`.

Each is emitted as `feature=()`. Header parsing must produce zero browser warnings;
a Playwright/Chromium upgrade that adds, removes, or renames a feature fails until
this reviewed policy, its version pin, and the browser evidence change together.

### Operations library and platform packages

Core is the only product state-machine authority. The GUI and CLI are clients;
neither owns record parsing, aggregation, verification, orchestration, or
publication semantics. Core consumes only declared public package entries.
Source and package guards reject browser-side core imports, API routes, deep
imports, sibling source escapes, unapproved Jinn packages, and duplicate
product operations.

### Local-process authority

Sponsor and delegated-agent grants provide local-process policy,
supervisability, and attribution. They are not operating-system access
control, remote authentication, or cryptographic protection from another
process or user that can modify the workspace. A malicious local workspace
owner is outside the authorization boundary and can deny service or replace
private mutable state; integrity checks make sealed-byte substitution and
malformed durable state fail closed.

### Optional evaluation-runtime worker

The Inspect adapter executes user-selected Python tasks, solvers, tools,
scorers, and providers only in a supervised child process. They never import
into the web request process. Selection seals the worker, Python executable,
installed-package environment, Inspect distribution, task source/project, and
material run configuration; launch re-probes that identity before accepting a
cell submission. The child receives a minimal environment with no ambient
credential variables. Credentialed provider execution is not supported until an
explicit allowlisted secret-forward port exists.

This process boundary isolates the web lifecycle from imported Python code but
is not a hostile-code or filesystem sandbox. Task code retains the product OS
user's filesystem permissions. A customer running untrusted or secret-bearing
code must isolate the complete worker in a container or worker host. See the
[Inspect runtime guide](./INSPECT-RUNTIME.md).

### Public disclosure

`publish` authorizes disclosure of BP-40's fixed allowlisted closure. Mutable
drafts, authority and audit state, private keys, scratch areas, environment
data, and absolute paths are excluded. Public record content is intentionally
public and is not reclassified as confidential by this product; the closure
is not a general PII scrubber. Portable verification authenticates one
snapshot and independently checks manifest, graph, trust, Matrix, Report,
claim, cancellation, and asset consistency after the source workspace is
gone.

Inspect native logs are private until an Inspect-backed publication receives
an explicit `includeNativeArtifacts` approval. That approval copies the exact
viewer-ready logs into the public bundle. Logs may contain prompts, responses,
tool calls, transcripts, model metadata, or user data; the product does not
silently scrub or reclassify them.

## Filesystem attack surface

Workspace and bundle paths are server-selected. Exact manifest-relative paths
reject absolute, dot, parent, duplicate, and unexpected members. Bundle reads
use no-follow opens and checked file descriptors and reject symbolic links,
hard links, special files, inode changes, byte mismatches, missing members,
and extras. Publication stages, fsyncs, and atomically renames a complete
digest-addressed directory without overwrite. Private keys are atomic local
files and never enter the public closure. These controls do not defend against
a privileged actor that can rewrite memory, the running process, or the
filesystem after verification.

## Cancellation and concurrency

Cancellation intent is durable before venue probing and is finalized only at
the real backend's terminal boundary. Collection, cancellation, and
publication use exact-owner, PID-start-aware, token/inode/directory-fenced
single-writer guards. Unknown liveness stays contended; stale recovery cannot
displace a successor. Backend close and venue shutdown finish before a driver
generation is recorded successful. These mechanisms target interruption,
race, stale-owner, and crash-recovery faults; they do not provide distributed
consensus across hostile hosts.

## Adversarial inputs and verification

Schema-valid record strings are rendered as text and escaped for HTML, SVG,
Markdown, or plain text. Links are fixed manifest-listed relative paths, not
record-controlled URLs. Tests cover hostile strings, unexpected errors,
pathname traversal, symlink/hardlink/special-file substitution, manifest and
record tampering, trust-key substitution, typed graph closure, Report/claim
inconsistency, each derived asset, and static active/remote content. The
production browser gate additionally checks accessibility, response headers,
console/network behavior, narrow layout, and absence of build/runtime/credential
sentinels, workspace paths, and actual generated private-key bytes from HTML,
Flight/action receipts, all browser console levels and request URLs, static browser
chunks, and the copied bundle. It then deletes the source workspace and invokes
the standalone shipped bundle verifier against only that copy. Every browser run
has a UUID temporary root and exact owner marker; exclusive creation leaves stale
crash roots untouched, and cleanup refuses an altered marker or neighboring run.

## Non-goals and residuals

- No hosted authentication, authorization service, multi-tenant isolation,
  deployment, package publication, or remote distribution.
- No confidentiality guarantee for public tasks, records, execution, or a
  bundle the sponsor authorizes for publication.
- No protection from a malicious or compromised local process owner.
- No claim that distinct agent keys prove independent real-world custody.
- No claim that local execution proves honesty against the run owner, that an
  evaluator majority is true, or that the product is a certification body.
- No generic sandbox, credential proxy, malware scanner, PII detector, or
  arbitrary-content sanitizer.
