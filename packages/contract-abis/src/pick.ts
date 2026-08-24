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
  if (value.indexed === true) out.indexed = true;
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

export function pickAbiItems(
  fullAbi: readonly AbiItem[],
  names: readonly string[],
): readonly AbiItem[] {
  const byName = new Map<string, AbiItem>();
  for (const item of fullAbi) {
    if (item.name !== undefined) {
      byName.set(item.name, normalizeAbiItem(item));
    }
  }
  return names.map((name) => {
    const item = byName.get(name);
    if (item === undefined) {
      throw new Error(`ABI item not found: ${name}`);
    }
    return item;
  });
}
