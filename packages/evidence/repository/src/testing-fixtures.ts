export interface DeclaredLimitFixtureProviders {
  readonly createObjectAtDeclaredLimit?: () => Uint8Array;
  readonly createObjectAboveDeclaredLimit?: () => Uint8Array;
}

export interface DeclaredLimitFixtures {
  readonly atLimit: Uint8Array;
  readonly aboveLimit: Uint8Array;
}

export function loadDeclaredLimitFixtures(
  maxObjectBytes: number,
  providers: DeclaredLimitFixtureProviders,
): DeclaredLimitFixtures {
  if (
    typeof providers.createObjectAtDeclaredLimit !== "function" ||
    typeof providers.createObjectAboveDeclaredLimit !== "function"
  ) {
    throw new TypeError(
      "A repository with maxObjectBytes must provide explicit at-limit and limit-plus-one fixtures.",
    );
  }

  const atLimit = providers.createObjectAtDeclaredLimit();
  if (atLimit.byteLength !== maxObjectBytes) {
    throw new TypeError(
      `The at-limit repository fixture must contain exactly ${maxObjectBytes} bytes.`,
    );
  }

  const aboveLimit = providers.createObjectAboveDeclaredLimit();
  const expectedAboveLimitBytes = maxObjectBytes + 1;
  if (aboveLimit.byteLength !== expectedAboveLimitBytes) {
    throw new TypeError(
      `The limit-plus-one repository fixture must contain exactly ${expectedAboveLimitBytes} bytes.`,
    );
  }

  return { atLimit, aboveLimit };
}
