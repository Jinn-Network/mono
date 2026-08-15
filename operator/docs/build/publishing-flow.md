# Publishing flow

Plain-prose walk through `jinn solver-plugins publish <source>`. Spec references: `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md` §5.2 / §5.3 / §6.3.

## Sequence

The `<source>` may be a **local plugin directory** (a bare path resolves as a `local` source), or an `npm:` / `git:` / `github:` reference. Publishing to Jinn is independent of npm publication: Jinn anchors its own IPFS tarball + on-chain record either way, so a public `npm publish` is optional.

1. **Resolve.** The verb resolves the plug-in source (npm, git, github, local path) via `operator/src/plugins/resolvers.ts`. It vendors the plug-in under `~/.jinn-client/solver-plugins/` and reads the manifest.

2. **Pack.** The packer (`jinn solver-plugins pack`) computes a deterministic sha256 digest over the directory and writes a tarball.

3. **Lazy Stage 1.** If the local fleet has no `fleet_agent_id` yet, the verb runs `ensureStage1(password)`:
   - Generates or loads the agent EOA.
   - Predicts the Safe address.
   - Pauses on the awaiting-funding gate if ETH is needed.
   - Deploys the Safe.
   - Mints the agent NFT via `IdentityRegistry.register()` and calls `setAgentWallet(agentId, safeAddress)`.
   - Marks `fleet_stage = "stage1"`.

   Stage 2 (operator-only state: service registration, OLAS bonding, mech deployment) is never touched.

4. **Upload to IPFS.** The packed tarball is pinned to IPFS via the Autonolas gateway. The returned CID is the canonical `pluginCid`.

5. **Encode payload.** The publisher ABI-encodes the `PLUGIN_PAYLOAD_TUPLE`:

   ```
   (version=1, pluginName, pluginVersion, pluginSha256, supports[], publishedAt)
   ```

6. **Submit on chain.** The publisher routes `IdentityRegistry.setMetadata(builderAgentId, "plugin:<cid>", payload)` through the Stage 1 Safe via `executeSafeTransaction`. The transaction is signed by the agent EOA and submitted from the Safe.

7. **Indexer picks it up.** The Ponder indexer's `MetadataSet` handler recognises the `plugin:` key prefix, decodes the payload, and writes a `pluginPublication` row with primary key `<builderAgentId>:<pluginCid>`.

8. **Discoverable.** Operators querying `listPluginPublications({ solverType: "swe-rebench-v2.v1" })` get back the new record. The `/build` route in the operator SPA renders the new plug-in under "Published plug-ins for SWE-rebench v2" within one indexer poll.

## Revocation

`jinn solver-plugins revoke <pluginCid>` writes a v2 revoked-marker payload to the same `plugin:<cid>` key. The indexer flips the row's `revoked` flag. Operators continue to see the row in the SPA but with a "revoked" badge.

## Attribution

When an operator runs a task and the verdict envelope is signed, the envelope's `executor.plugins[]` field carries `{ name, version, cid, sha256 }` per plug-in. The indexer joins each `executor.plugins[].cid` against `pluginPublication.pluginCid` to resolve a builder agentId. The score attributes to your builder identity.

If the envelope's plug-in sha256 mismatches the publication's sha256, the run is flagged `forkSuspected: true` and excluded from builder-credit aggregations. Forks score the operator but not the builder.
