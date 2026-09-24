# Demo-1 lock anchors

Third-party time evidence over the confirmatory lock's Analysis Manifest digest:

```
sha256:822b2f7469dc2e58a3e72eee32688614d296ba20fc381d9a074e3935a68622b3
```

Per the pluggable-integrity-providers design (2026-08-17): an anchor has no claim content
and proves nothing about meaning or correctness; it only dates bytes. A verified anchor moves
the preregistration claim from tool-enforced discipline toward *committed* — never *attested*.

| file | provider | status |
|---|---|---|
| `lock-manifest.tsq` / `lock-manifest.tsr` | RFC 3161, freetsa.org | complete — token signed `2026-08-18 11:11:07 GMT` |
| `freetsa-tsa.crt`, `freetsa-cacert.pem` | — | verification certificates |
| `lock-manifest.ots-calendar-{alice,bob,finney}.bin` | OpenTimestamps calendars | pending — upgrade to Bitcoin-attested after confirmation |

Verify the RFC 3161 token offline:

```bash
openssl ts -verify -digest 822b2f7469dc2e58a3e72eee32688614d296ba20fc381d9a074e3935a68622b3 -sha256 \
  -in lock-manifest.tsr -CAfile freetsa-cacert.pem -untrusted freetsa-tsa.crt
```

Ordering discipline (mirroring the design's `anchor` operation, which refuses a lock anchor
obtained after launch): a first confirmatory dispatch began 2026-08-18 ~10:45 UTC, before this
anchor existed. Every cell from that dispatch was destroyed unread — the worker cell files were
deleted before any collection — and confirmatory dispatch was restarted only after the token
above was obtained and verified. The confirmatory evidence set therefore postdates the anchored
lock in its entirety. These proof bytes are carried here exactly as received; sealing them as
AnchorEvidence records happens without changing the bytes. PR #2786 shipped that machinery for
the classic lineage; this report is evidence-native, so its own carriage waits on the surface
described below.

## Which of these the published bundle will carry

Ruled on issue #2974 and specified in
[`spec/2026-09-02-evidence-native-anchor-surface.md`](../../../../../spec/2026-09-02-evidence-native-anchor-surface.md):
the documented re-report of this report will carry **the freetsa RFC 3161 token only**.

The three OpenTimestamps calendar proofs above are *held but uncarried*. They are still
`pending` — no Bitcoin attestation has been folded into them — and a reader never upgrades a
pending proof and never contacts a provider, so a pending proof carried into a bundle stays
pending in every reader forever unless the bundle is republished again. Carrying them once they
are Bitcoin-attested remains available to a later re-report and is not foreclosed by this
decision; the bytes stay here in the meantime.

Both the carriage and the re-report wait on the composed generation
`benchmark-product-public-bundle/10` (issues #3403 → #3406). The published bundle is
`benchmark-product-public-bundle/5`, which has no anchor surface at all, so until `/10` exists
these proofs cannot be sealed into any bundle — they can only be verified here, offline, by the
command above.
