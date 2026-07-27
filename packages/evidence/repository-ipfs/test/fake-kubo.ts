// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  CID,
  type KuboRPCClient,
} from "kubo-rpc-client";

import type {
  IpfsBlockReader,
} from "../src/readers.js";

export interface FakeKuboPutCall {
  readonly bytes: Uint8Array;
  readonly options: Record<string, unknown>;
}

export interface FakeKuboRemoteCall {
  readonly cid: string;
  readonly options: Record<string, unknown>;
}

export class FakeIpfsBlockReader implements IpfsBlockReader {
  readonly blocks = new Map<string, Uint8Array>();
  readonly calls: string[] = [];
  readonly scripted = new Map<
    string,
    Array<Uint8Array | null | Error>
  >();
  onCall: ((cid: string) => void) | undefined;

  async getBlock(
    cid: string,
    options: { readonly signal?: AbortSignal; readonly maxBytes: number },
  ): Promise<Uint8Array | null> {
    this.calls.push(cid);
    this.onCall?.(cid);
    if (options.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    const queue = this.scripted.get(cid);
    const scripted = queue?.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted === null) return null;
    if (scripted !== undefined) return Uint8Array.from(scripted);
    const bytes = this.blocks.get(cid);
    return bytes === undefined ? null : Uint8Array.from(bytes);
  }
}

export class FakeKubo {
  readonly reader: FakeIpfsBlockReader;
  readonly events: string[] = [];
  readonly putCalls: FakeKuboPutCall[] = [];
  readonly remoteAddCalls: FakeKuboRemoteCall[] = [];
  readonly remoteListCalls: FakeKuboRemoteCall[] = [];
  readonly localPins = new Set<string>();
  readonly localPinTypes = new Map<
    string,
    "direct" | "recursive" | "indirect"
  >();
  readonly remotePins = new Set<string>();
  remoteStatus: "queued" | "pinning" | "pinned" | "failed" = "pinned";
  returnedCidOverride: string | undefined;
  localListCidOverride: string | undefined;
  remoteAddCidOverride: string | undefined;
  remoteListCidOverride: string | undefined;
  failNextPut: Error | undefined;
  failNextPinList: Error | undefined;
  failNextRemoteAdd: Error | undefined;
  failNextRemoteList: Error | undefined;
  throwWhenPinMissing = false;
  onEvent: ((event: string) => void) | undefined;

  constructor(reader = new FakeIpfsBlockReader()) {
    this.reader = reader;
  }

  asClient(): KuboRPCClient {
    const self = this;
    return {
      block: {
        async put(bytes: Uint8Array, options: Record<string, unknown> = {}) {
          self.events.push("block.put");
          self.onEvent?.("block.put");
          self.putCalls.push({
            bytes: Uint8Array.from(bytes),
            options: { ...options },
          });
          if (self.failNextPut !== undefined) {
            const error = self.failNextPut;
            self.failNextPut = undefined;
            throw error;
          }
          const cid = rawCidFor(bytes);
          self.reader.blocks.set(cid, Uint8Array.from(bytes));
          if (options.pin === true) {
            self.localPins.add(cid);
            self.localPinTypes.set(cid, "recursive");
          }
          return decodeRawCid(self.returnedCidOverride ?? cid);
        },
      },
      pin: {
        async *ls(
          options: {
            readonly paths?: string | CID | Array<string | CID>;
            readonly type?: "direct" | "recursive" | "indirect" | "all";
          } = {},
        ) {
          self.events.push("pin.ls");
          self.onEvent?.("pin.ls");
          if (self.failNextPinList !== undefined) {
            const error = self.failNextPinList;
            self.failNextPinList = undefined;
            throw error;
          }
          const paths = Array.isArray(options.paths)
            ? options.paths
            : options.paths === undefined
              ? []
              : [options.paths];
          let found = false;
          for (const path of paths) {
            const canonicalPath =
              typeof path === "string"
                ? path
                : rawCidForDigest(path.multihash.digest);
            if (self.localPins.has(canonicalPath)) {
              const type = self.localPinTypes.get(canonicalPath) ?? "direct";
              if (
                options.type !== undefined &&
                options.type !== "all" &&
                options.type !== type
              ) {
                continue;
              }
              found = true;
              yield {
                cid: overrideCid(
                  decodeRawCid(canonicalPath),
                  self.localListCidOverride,
                ),
                type,
              };
            }
          }
          if (
            !found &&
            paths.length > 0 &&
            self.throwWhenPinMissing
          ) {
            const path = paths[0]!;
            const canonicalPath =
              typeof path === "string"
                ? path
                : rawCidForDigest(path.multihash.digest);
            throw Object.assign(
              new Error(
                `path '${decodeRawCid(canonicalPath).toString()}' is not pinned`,
              ),
              {
                response: { status: 500 },
              },
            );
          }
        },
        remote: {
          async add(cid: CID, options: Record<string, unknown>) {
            self.events.push("pin.remote.add");
            self.onEvent?.("pin.remote.add");
            self.remoteAddCalls.push({
              cid: rawCidForDigest(cid.multihash.digest),
              options: { ...options },
            });
            if (self.failNextRemoteAdd !== undefined) {
              const error = self.failNextRemoteAdd;
              self.failNextRemoteAdd = undefined;
              throw error;
            }
            const text = cid.toString();
            if (self.remoteStatus === "pinned") self.remotePins.add(text);
            return {
              cid: overrideCid(cid, self.remoteAddCidOverride),
              name: "",
              status: self.remoteStatus,
            };
          },
          async *ls(
            query: {
              readonly cid?: readonly CID[];
              readonly [key: string]: unknown;
            } = {},
          ) {
            self.events.push("pin.remote.ls");
            self.onEvent?.("pin.remote.ls");
            if (self.failNextRemoteList !== undefined) {
              const error = self.failNextRemoteList;
              self.failNextRemoteList = undefined;
              throw error;
            }
            for (const cid of query.cid ?? []) {
              self.remoteListCalls.push({
                cid: rawCidForDigest(cid.multihash.digest),
                options: { ...query },
              });
              if (self.remotePins.has(cid.toString())) {
                yield {
                  cid: overrideCid(cid, self.remoteListCidOverride),
                  name: "",
                  status: "pinned" as const,
                };
              }
            }
          },
        },
      },
    } as unknown as KuboRPCClient;
  }
}

function overrideCid(cid: CID, value: string | undefined): CID {
  return value === undefined
    ? cid
    : ({ toString: () => value } as CID);
}

export function rawCidFor(bytes: Uint8Array): string {
  return `f01551220${createHash("sha256").update(bytes).digest("hex")}`;
}

function decodeRawCid(cid: string): CID {
  return CID.decode(Buffer.from(cid.slice(1), "hex"));
}

function rawCidForDigest(digest: Uint8Array): string {
  return `f01551220${Buffer.from(digest).toString("hex")}`;
}
