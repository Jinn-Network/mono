/**
 * The product's platform consumption seam (spec §3): imports are public
 * package entries only — no deep imports, no copied platform code. As the
 * product grows, new platform surfaces are re-exported here, not reached
 * into directly from product code.
 */
export { BENCHMARKING_PROTOCOL } from "@jinn-network/benchmarking-records";
