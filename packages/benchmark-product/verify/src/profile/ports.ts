import { BENCHMARKING_METHOD_REGISTRY, type MethodPorts } from "@jinn-network/benchmarking-aggregate";

/** Public byte-resolver adapter used to re-verify a bundle-carried Report. */
export function buildMethodPortsFromResolver(
  resolveBytes: (digest: string) => Uint8Array | undefined,
): MethodPorts {
  return {
    registry: BENCHMARKING_METHOD_REGISTRY,
    resolveVerdictBytes: resolveBytes,
    resolveRunBytes: resolveBytes,
    resolveTaskBytes: resolveBytes,
  };
}
