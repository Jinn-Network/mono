# consent-v1

The §7.4a consent-chain scenarios (genesis stands alone, self-extension
via an incumbent `controls` voucher, cross-account consent via a
`scope:bindings` countersigning key, missing-consent rejection) are
executable fixtures in `src/conformance.ts`'s "consent chains" battery.

Why executable, not static: a consent scenario is a relationship between
two registered bindings (the new binding and, for the cross-account case,
the countersigning key's own binding) plus a countersignature field --
naturally expressed via `src/fixtures.ts` builders and `fakes.ts`
registrations, not a single static document.
