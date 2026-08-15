/**
 * Layer 2 — runtime conformance stubs.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.2 traced-I/O boundary + §4.10 (V2 TEE integration plug-in points).
 *
 * V1 does not implement runtime enforcement (that requires a TEE sandbox with
 * seccomp-bpf, Linux namespaces, and TLS transcript capture). These stubs
 * return `skipped: true` in V1 so operators can see the full attested-tier
 * picture in the ConformanceReport without needing a V2 runtime.
 *
 * When V2 ships, replace each stub body with a real implementation that reads
 * the executor runtime manifest, queries the TEE attestation quote, and
 * verifies the captured TLS transcripts. See Plan V2 for the full spec.
 */

import type { CheckResult, ConformanceContext } from '../types.js';

const V2_NOTE = 'V2 TEE integration plug-in point — see Plan V2';

/**
 * Check id: `runtime.seccomp`
 * Layer: 2
 *
 * V1 stub — always skipped. V2 will verify that the executor's seccomp-bpf
 * policy matches the reference policy in the TEE attestation manifest,
 * confirming that only the declared system-call surface is available.
 */
export function checkSeccompPolicy(_ctx: ConformanceContext): CheckResult {
  return {
    id: 'runtime.seccomp',
    layer: 2,
    passed: true,
    skipped: true,
    detail: V2_NOTE,
  };
}

/**
 * Check id: `runtime.namespace`
 * Layer: 2
 *
 * V1 stub — always skipped. V2 will verify that the executor runs inside a
 * Linux user namespace / network namespace policy that matches the declared
 * TEE isolation profile (no unexpected network interfaces, bind-mounts, etc.).
 */
export function checkNamespacePolicy(_ctx: ConformanceContext): CheckResult {
  return {
    id: 'runtime.namespace',
    layer: 2,
    passed: true,
    skipped: true,
    detail: V2_NOTE,
  };
}

/**
 * Check id: `runtime.tls-transcript`
 * Layer: 2
 *
 * V1 stub — always skipped. V2 will verify that the captured TLS transcripts
 * (BoringSSL SSLKEYLOGFILE or eBPF tap) cover all outbound connections and
 * that every connection's SNI appears in the declared egress allowlist.
 */
export function checkTlsTranscriptCapture(_ctx: ConformanceContext): CheckResult {
  return {
    id: 'runtime.tls-transcript',
    layer: 2,
    passed: true,
    skipped: true,
    detail: V2_NOTE,
  };
}
