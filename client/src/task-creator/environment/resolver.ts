// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod/v3';
import {
  EnvironmentBuildRecipeV1Schema,
  EnvironmentBuildRequestV1Schema,
  type EnvironmentBuildRecipeV1,
  type EnvironmentBuildRequestV1,
} from './contracts.js';

const ResolverSupportSchema = z.discriminatedUnion('supported', [
  z.object({ supported: z.literal(true), confidence: z.enum(['explicit', 'deterministic', 'agentic']) }).strict(),
  z.object({ supported: z.literal(false), reason: z.string().min(1) }).strict(),
]);

export type EnvironmentRecipeResolver = {
  readonly id: string;
  readonly version: string;
  supports(request: EnvironmentBuildRequestV1): Promise<z.infer<typeof ResolverSupportSchema>>;
  /** Deliberately unknown until the registry has strictly parsed the artifact. */
  resolve(request: EnvironmentBuildRequestV1): Promise<unknown>;
};

export type EnvironmentRecipeResolution =
  | { kind: 'resolved'; resolverId: string; resolverVersion: string; recipe: EnvironmentBuildRecipeV1 }
  | { kind: 'awaiting_input'; reason: 'no-supported-environment-recipe' }
  | { kind: 'terminal_error'; resolverId: string; resolverVersion: string; reason: string };

/**
 * Resolver ordering is policy. The first configured resolver that claims a
 * request wins; an exception or malformed recipe from that resolver is final
 * rather than permission to reinterpret inputs in a later resolver.
 */
export class EnvironmentRecipeResolverRegistry {
  constructor(private readonly resolvers: readonly EnvironmentRecipeResolver[]) {}

  async resolve(input: unknown): Promise<EnvironmentRecipeResolution> {
    const request = EnvironmentBuildRequestV1Schema.parse(input);

    for (const resolver of this.resolvers) {
      let support: z.infer<typeof ResolverSupportSchema>;
      try {
        support = ResolverSupportSchema.parse(await resolver.supports(request));
      } catch (error) {
        return terminal(resolver, `invalid support declaration: ${message(error)}`);
      }
      if (!support.supported) continue;

      try {
        const recipe = EnvironmentBuildRecipeV1Schema.parse(await resolver.resolve(request));
        return {
          kind: 'resolved',
          resolverId: resolver.id,
          resolverVersion: resolver.version,
          recipe,
        };
      } catch (error) {
        return terminal(resolver, `invalid claimed recipe: ${message(error)}`);
      }
    }

    return { kind: 'awaiting_input', reason: 'no-supported-environment-recipe' };
  }
}

function terminal(resolver: EnvironmentRecipeResolver, reason: string): EnvironmentRecipeResolution {
  return {
    kind: 'terminal_error',
    resolverId: resolver.id,
    resolverVersion: resolver.version,
    reason,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
