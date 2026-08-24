import type { AbiItem } from "./pick.js";

type SliceModule = {
  readonly export: string;
  readonly items: readonly AbiItem[];
};

export function exportSlice(module: SliceModule): readonly AbiItem[] {
  return module.items;
}
