#!/usr/bin/env node
// Passthrough alias for the `colophon-check` executable. Argument handling, output, and exit
// status are the checker's own: this shim only re-enters it, so `colophon-verify` and
// `colophon-check` behave identically. See ./index.js.
import "@colophon-claims/check/bin";
