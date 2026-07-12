// Type declarations for the JS boot helper (issue #1429). Kept as a sidecar so
// the runtime stays a dependency-free .mjs the Dockerfile CMD can `node`.
export function resolveDatabaseSchema(args: {
  schemaSource: string;
  env?: Record<string, string | undefined>;
}): string;
