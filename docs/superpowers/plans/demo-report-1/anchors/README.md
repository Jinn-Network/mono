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
AnchorEvidence records happens when the pluggable-integrity-providers implementation (PR #2786)
lands, without changing the bytes.
