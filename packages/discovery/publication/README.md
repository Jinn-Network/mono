# `@jinn-network/record-publication`

Kind-neutral, durable execution of exact-byte publication plans. A plan is transient tier-3
application data: it coordinates dependency-ordered storage, mirrored bytes, owned/delegated
Record Discovery announcements, and origin verification without defining any record family.

The coordinator uses injected exact-object, CAS-journal, authorization, origin-verification, and destination
ports. `createDiscoverySourceAnnouncementPort` composes the existing durable Record Discovery
source writer. Origin-reference records are never announced through the local source; they are
verified and may be mirrored without reattribution.
