# Platform architecture control

Repository ownership is enforced locally by `.github/scripts/architecture-control.mjs`. It enumerates every catalog manifest, catalog reference, declared and discovered public/testing surface, generator source, and generated-output source, then evaluates `.github/CODEOWNERS` with last-match semantics. Its deterministic JSON coverage report is the machine-readable record of the paths checked.

The `platform-architecture-control` pull-request workflow runs that validator against the explicit pull-request head SHA. It also calls the reusable platform verifier in its non-publishing `canary` lane. The final `platform-verification` job fails unless the reusable verifier reports exact success. Neither job publishes a package.

The reusable verifier creates artifact attestations and therefore requests `id-token: write`, `attestations: write`, and `artifact-metadata: write`. GitHub restricts write-capable tokens for pull requests from forks. A fork run can fail at that permission boundary even when its source is valid; a maintainer must rerun the same head SHA in the trusted repository context. `pull_request_target` is intentionally not used.

The scheduled/manual architecture-policy audit only reads GitHub API state. `ARCHITECTURE_AUDIT_TOKEN`, when configured, must be a fine-grained read-only token able to view branch protection and collaborator permissions. The workflow falls back to `GITHUB_TOKEN`; if that token cannot view collaborator membership, the report records visibility as unavailable and fails closed because write eligibility was not proven. Branch protection itself remains an external administrator setting: a repository administrator must configure or repair it manually. The audit never changes live settings.
