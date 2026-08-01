// SPDX-License-Identifier: Apache-2.0

/**
 * The three seams that let this package speak to a running simulator without holding any
 * ambient authority. Task 14 completes the host surface; state-read resolution needs only
 * `RpcTransport` today.
 */

export interface RpcTransport {
  send(request: {
    readonly endpoint: string;
    readonly method: string;
    readonly params: readonly unknown[];
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}
