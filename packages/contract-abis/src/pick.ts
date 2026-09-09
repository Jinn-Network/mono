export type AbiComponent = {
  type: string;
  name?: string;
  indexed?: boolean;
  components?: AbiComponent[];
};

export type AbiItem = AbiComponent & {
  type: string;
  name?: string;
  stateMutability?: string;
  anonymous?: boolean;
  inputs?: AbiComponent[];
  outputs?: AbiComponent[];
};

export function normalizeAbiValue(value: AbiComponent): AbiComponent {
  const out: AbiComponent = { type: value.type };
  if (value.name !== undefined) out.name = value.name;
  if (value.indexed !== undefined) out.indexed = value.indexed;
  if (value.components !== undefined) {
    out.components = value.components.map(normalizeAbiValue);
  }
  return out;
}

export function normalizeAbiItem(item: AbiItem): AbiItem {
  const out: AbiItem = { type: item.type };
  if (item.name !== undefined) out.name = item.name;
  if (item.stateMutability !== undefined) out.stateMutability = item.stateMutability;
  if (item.anonymous === true) out.anonymous = true;
  if (item.inputs !== undefined) out.inputs = item.inputs.map(normalizeAbiValue);
  if (item.outputs !== undefined) out.outputs = item.outputs.map(normalizeAbiValue);
  return out;
}

function canonicalType(component: AbiComponent): string {
  if (component.type.startsWith("tuple")) {
    const inner = (component.components ?? []).map(canonicalType).join(",");
    // The suffix carries any array shape (`[]`, `[2]`), so a tuple[] stays expressible.
    return `(${inner})${component.type.slice("tuple".length)}`;
  }
  return component.type;
}

function canonicalInputs(item: AbiItem): string {
  return (item.inputs ?? []).map(canonicalType).join(",");
}

function ambiguousItemError(
  entry: string,
  candidates: readonly AbiItem[],
  context?: string,
): Error {
  const where = context === undefined ? "" : ` in ${context}`;
  const listed = candidates
    .map((item) => `  ${item.type} ${item.name}(${canonicalInputs(item)})`)
    .join("\n");
  const example = `${candidates[0].name}(${canonicalInputs(candidates[0])})`;
  return new Error(
    `Ambiguous ABI item "${entry}"${where}:\n${candidates.length} items match:\n${listed}\n` +
      `Disambiguate in slices.manifest.json with the full signature, e.g. "${example}".`,
  );
}

/**
 * Resolve manifest entries against a full ABI. An entry is either a bare name
 * (`"createTask"`) or a canonical signature (`"claimTask(uint256,address)"`),
 * which selects one overload. A name matching more than one item is a hard
 * error rather than a silent last-wins pick. `context` names the caller (the
 * generator passes its slice and contract) and is appended to that error.
 */
export function pickAbiItems(
  fullAbi: readonly AbiItem[],
  names: readonly string[],
  context?: string,
): readonly AbiItem[] {
  const byName = new Map<string, AbiItem[]>();
  for (const item of fullAbi) {
    if (item.name !== undefined) {
      const existing = byName.get(item.name);
      if (existing === undefined) {
        byName.set(item.name, [normalizeAbiItem(item)]);
      } else {
        existing.push(normalizeAbiItem(item));
      }
    }
  }
  return names.map((entry) => {
    const open = entry.indexOf("(");
    const candidates = byName.get(open === -1 ? entry : entry.slice(0, open)) ?? [];
    const matches =
      open === -1
        ? candidates
        : candidates.filter(
            // `slice(open + 1, -1)` requires the entry to END at its closing paren, so a
            // malformed `"foo(uint256)junk"` falls through to the not-found error rather than
            // silently resolving.
            (item) => canonicalInputs(item) === entry.slice(open + 1, -1),
          );
    if (matches.length === 0) {
      throw new Error(`ABI item not found: ${entry}`);
    }
    if (matches.length > 1) {
      throw ambiguousItemError(entry, matches, context);
    }
    return matches[0];
  });
}
