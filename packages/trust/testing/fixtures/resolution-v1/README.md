# resolution-v1

At-time resolution scenarios (window checks against a resolved binding's
`effectiveStart`/`expiresAt`, resolving the historically-correct binding
across a key rotation, an absent/unresolved binding) are executable
fixtures in `src/conformance.ts`'s "at-time resolution" battery.

Why executable, not static: these are time-window relationships between
multiple registered bindings (a rotation scenario needs two bindings with
adjacent `validFrom`/`validTo` windows), not single documents -- they are
naturally expressed as `fakes.ts` registrations, not static JSON records.

The underlying anchor-ordering, `effectiveStart = max(validFrom,
anchorTime)`, earlier-anchored-wins conflict resolution, and the §7.2
agentId composition leg are `@jinn-network/trust-resolve`'s own scope
(Task T13, `anchors.test.ts`/`binding-resolver.test.ts`) -- this battery
tests `verify.ts`'s consumption of an already-resolved binding's window
fields, not resolution itself.
