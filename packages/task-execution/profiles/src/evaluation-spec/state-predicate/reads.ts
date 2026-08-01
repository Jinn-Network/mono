import type { StatePredicateBlock } from "../family-blocks.js";
import type { AbiArg, CallTarget, Predicate } from "./vocabulary.js";

export type StateRead =
  | { kind: "nativeBalance"; account: string }
  | { kind: "erc20Balance"; token: string; account: string }
  | { kind: "storageValue"; address: string; slot: string }
  | { kind: "call"; to: string; call: CallTarget };

export interface StateReadRequest {
  readonly key: string;
  readonly state: "baseline" | "post-replay";
  readonly read: StateRead;
}

export interface SourceReadRequest {
  readonly key: string;
  readonly read: { world: string; requestKey: string; selector: string };
}

/** Canonical key for a state read. Inputs are lowercase-by-schema, so this is concatenation —
 * no normalization step exists that a producer and a consumer could implement differently. */
export function stateReadKey(read: StateRead): string {
  switch (read.kind) {
    case "nativeBalance":
      return `native-balance|${read.account}`;
    case "erc20Balance":
      return `erc20-balance|${read.token}|${read.account}`;
    case "storageValue":
      return `storage|${read.address}|${read.slot}`;
    case "call":
      return `call|${read.to}|${callTargetKey(read.call)}`;
  }
}

/**
 * The key of a call target, over the DECLARATION (CR6). CE2 cannot resolve the declarative form
 * to calldata, so it does not key over calldata: two predicates naming the same declarative call
 * key identically whether or not anyone ever encodes them, and the encoded and declarative
 * spellings of one underlying call are two keys — consistent, deterministic, and not something
 * this module is in a position to deduplicate.
 */
function callTargetKey(target: CallTarget): string {
  if ("encodedCall" in target) return `encoded|${target.encodedCall}`;
  const abiDigest = target.abiRef.digest?.["sha256"] ?? "";
  return `abi|${abiDigest}|${target.function}|${target.args.map(abiArgKey).join(",")}`;
}

/** One argument as a key segment. `type:value` for scalars, `type:[v1;v2]` for arrays — the
 * values are already canonical strings (lowercase hex, decimal, "true"/"false") by schema, so
 * this is projection, never formatting. */
function abiArgKey(arg: AbiArg): string {
  return "values" in arg ? `${arg.type}:[${arg.values.join(";")}]` : `${arg.type}:${String(arg.value)}`;
}

export function sourceReadKey(read: { world: string; requestKey: string; selector: string }): string {
  return `source|${read.world}|${read.requestKey}|${read.selector}`;
}

/**
 * The projection contract (finding CE2-F1): every state read the block's predicates require,
 * with the state each must be taken at. An observation builder (CE3's probe executor or
 * replayer) fulfils exactly this list; the evaluator resolves by key and NEVER substitutes a
 * differently-tagged read — which is what makes §6.2's pre-replay ground-truth rule enforceable.
 * Success/safety predicates read `post-replay`; `reportedValue.groundTruth` reads `baseline`
 * unless the author declared `groundTruthState: "post-replay"`.
 *
 * Observation producer obligation (CR6): a `call` read arrives in whichever form the author
 * declared. `{encodedCall}` is calldata, send it. `{abiRef, function, args}` is a declaration —
 * resolve the selector from the canonical `function` signature and encode `args` by their
 * declared types, then send that. Report the result under the `key` this module computed,
 * unchanged: the key is over the declaration, so an encoder that normalizes, reorders, or
 * re-spells anything must not feed that back into the key. This is the entire CE2↔CE3 contract
 * for the declarative form, and it lives next to the code that emits it rather than only in the
 * plan.
 */
export function stateReadRequests(block: StatePredicateBlock): StateReadRequest[] {
  const requests: StateReadRequest[] = [];
  const seen = new Set<string>();

  const add = (read: StateRead, state: "baseline" | "post-replay") => {
    const key = stateReadKey(read);
    const identity = `${state}|${key}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    requests.push({ key, state, read });
  };

  const collectFromPredicate = (predicate: Predicate) => {
    switch (predicate.kind) {
      case "nativeBalance":
        add({ kind: "nativeBalance", account: predicate.account }, "post-replay");
        break;
      case "erc20Balance":
        add({ kind: "erc20Balance", token: predicate.token, account: predicate.account }, "post-replay");
        break;
      case "callResult":
        add({ kind: "call", to: predicate.to, call: predicate.call }, "post-replay");
        break;
      case "storageValue":
        add({ kind: "storageValue", address: predicate.address, slot: predicate.slot }, "post-replay");
        break;
      case "reportedValue":
        add(
          { kind: "call", to: predicate.groundTruth.to, call: predicate.groundTruth.call },
          predicate.groundTruthState ?? "baseline",
        );
        break;
      default:
        break;
    }
  };

  for (const predicate of block.successPredicates) collectFromPredicate(predicate);
  for (const predicate of block.safetyConstraints) collectFromPredicate(predicate);
  for (const measurement of block.measurements) {
    if (measurement.observe.kind === "reportedValue") {
      // Measurements observe reported values from the observation's `reports` array only.
      continue;
    }
  }

  return requests;
}

export function sourceReadRequests(block: StatePredicateBlock): SourceReadRequest[] {
  const requests: SourceReadRequest[] = [];
  const seen = new Set<string>();

  const add = (read: { world: string; requestKey: string; selector: string }) => {
    const key = sourceReadKey(read);
    if (seen.has(key)) return;
    seen.add(key);
    requests.push({ key, read });
  };

  const collectFromPredicate = (predicate: Predicate) => {
    if (predicate.kind === "sourceValue") {
      add({ world: predicate.world, requestKey: predicate.requestKey, selector: predicate.selector });
    }
  };

  for (const predicate of block.successPredicates) collectFromPredicate(predicate);
  for (const predicate of block.safetyConstraints) collectFromPredicate(predicate);

  return requests;
}
