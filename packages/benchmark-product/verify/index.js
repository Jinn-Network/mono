// Passthrough alias. `@colophon-claims/verify` was the checker's first published name; the
// implementation now ships as `@colophon-claims/check`. This name stays published forever so
// every already-sealed bundle instruction (`npx @colophon-claims/verify@0.1 ./bundle`,
// `npx @colophon-claims/verify@0.2 ./bundle`) keeps resolving and behaving exactly as before.
export * from "@colophon-claims/check";
