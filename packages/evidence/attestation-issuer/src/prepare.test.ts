// SPDX-License-Identifier: Apache-2.0

import {
  DSSE_PAYLOAD_TYPE,
  dssePreAuthEncoding,
  validateExecutionVerification,
  validateResultEvaluation,
} from "@jinn-network/evidence-protocol";
import * as protocol from "@jinn-network/evidence-protocol";
import { describe, expect, test, vi } from "vitest";

import {
  buildResultEvaluationPayload,
  prepareExecutionVerification,
  prepareResultEvaluation,
} from "./prepare.js";
import type { DsseSigner, DsseSigningRequest } from "./types.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const signer: DsseSigner = async () => [{
  keyid: "test-key",
  signature: new Uint8Array([1, 2, 3, 4]),
}];

describe("attestation preparation", () => {
  test("signs exact Result Evaluation payload and validates the envelope", async () => {
    const calls: DsseSigningRequest[] = [];
    const observingSigner: DsseSigner = async (request) => {
      calls.push({
        ...request,
        payloadBytes: Uint8Array.from(request.payloadBytes),
        preAuthEncoding: Uint8Array.from(request.preAuthEncoding),
      });
      request.payloadBytes[0] = 0;
      return [{ keyid: "test-key", signature: new Uint8Array([1, 2, 3, 4]) }];
    };
    const prepared = await prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, observingSigner);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(calls[0]?.preAuthEncoding).toEqual(
      dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, calls[0]!.payloadBytes),
    );
    expect(validateResultEvaluation(prepared.envelopeBytes)).toMatchObject({
      conforms: true,
      recordDigest: prepared.recordDigest,
    });
  });

  test("builds the same canonical Result Evaluation payload without exposing a signer", async () => {
    const input = {
      task: { name: "task", digest },
      results: [{ name: "result", digest }] as [{ name: string; digest: typeof digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass" as const,
    };
    const prepared = await prepareResultEvaluation(input, signer);
    expect(buildResultEvaluationPayload(input)).toEqual(prepared.payloadBytes);
  });

  test("prepares Execution Verification and preserves signature order", async () => {
    const firstSignature = new Uint8Array([1]);
    Object.defineProperty(firstSignature, Symbol.iterator, {
      value: function* () {
        yield 99;
      },
    });
    const prepared = await prepareExecutionVerification({
      executionEvidenceDigest: digest,
      executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      verifier: { id: "https://example.test/verifier" },
      verifiedAt: "2026-07-24T12:00:00Z",
      verdict: "verified",
    }, async () => [
      { keyid: "first", signature: firstSignature },
      { signature: new Uint8Array([2]) },
    ]);
    expect(validateExecutionVerification(prepared.envelopeBytes).conforms).toBe(true);
    expect(prepared.value.envelope.signatures).toEqual([
      { keyid: "first", sig: "AQ==" },
      { sig: "Ag==" },
    ]);
  });

  test.each<unknown>([
    [],
    [{ signature: new Uint8Array() }],
    [{ signature: "bytes" }],
    [{ signature: new Uint8Array([1]), keyid: 1 }],
    Array(1),
    [Object.defineProperty({}, "signature", {
      enumerable: true,
      get: () => new Uint8Array([1]),
    })],
  ])("rejects invalid signer output %#", async (output) => {
    await expect(prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, async () => output as never)).rejects.toMatchObject({
      code: "INVALID_SIGNER_OUTPUT",
    });
  });

  test("preserves own __proto__ extensions in the exact signed payload", async () => {
    const statementExtensions = JSON.parse(
      '{"__proto__":{"retained":true},"ordinary":1}',
    );
    const prepared = await prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
      statementExtensions,
    }, signer);
    expect(Object.hasOwn(prepared.value.statement, "__proto__")).toBe(true);
    expect(prepared.value.statement.__proto__).toEqual({ retained: true });
  });

  test("wraps signer failure and honors cancellation", async () => {
    const cause = new Error("injected");
    await expect(prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, async () => { throw cause; })).rejects.toMatchObject({
      code: "SIGNING_FAILED",
      cause,
    });
    const controller = new AbortController();
    controller.abort();
    const spy = vi.fn(signer);
    await expect(prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, spy, { signal: controller.signal })).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  test("checks cancellation again after signing", async () => {
    const controller = new AbortController();
    await expect(prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, async () => {
      controller.abort("after-signing");
      return [{ signature: new Uint8Array([1]) }];
    }, { signal: controller.signal })).rejects.toMatchObject({
      code: "OPERATION_ABORTED",
      cause: "after-signing",
    });
  });

  test("invalid input never calls the signer", async () => {
    const valid = {
      task: { name: "task", digest },
      results: [{ name: "result", digest }] as const,
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass" as const,
    };
    const invalid = [
      { ...valid, task: { name: "", digest } },
      { ...valid, task: { name: "task", digest: `sha256:${"A".repeat(64)}` } },
      { ...valid, results: [] },
      { ...valid, results: [{ name: "task", digest }] },
      { ...valid, evaluator: { id: "relative" } },
      { ...valid, evaluator: { id: "urn:bad space" } },
      { ...valid, evaluator: { id: "https://example.test/%ZZ" } },
      { ...valid, evaluator: { id: "https://example.test/\u0000" } },
      { ...valid, evaluatedAt: "2026-02-30T12:00:00Z" },
      { ...valid, explanation: "" },
      { ...valid, measurements: [{ name: "", value: 1 }] },
      { ...valid, statementExtensions: { subject: [] } },
      { ...valid, predicateExtensions: { verdict: "fail" } },
      {
        ...valid,
        task: {
          name: "task",
          digest,
          extensions: { content: "PRIVATE TASK BYTES" },
        },
      },
      {
        ...valid,
        task: Object.assign(Object.create({ name: "inherited" }), { digest }),
      },
      { ...valid, statementExtensions: { sparse: Array(1) } },
    ];
    for (const input of invalid) {
      const spy = vi.fn(signer);
      await expect(prepareResultEvaluation(input as never, spy)).rejects.toMatchObject({
        code: "INVALID_ISSUANCE_INPUT",
      });
      expect(spy).not.toHaveBeenCalled();
    }

    const verification = {
      executionEvidenceDigest: digest,
      executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      verifier: { id: "https://example.test/verifier" },
      verifiedAt: "2026-07-24T12:00:00Z",
      verdict: "verified" as const,
    };
    for (const input of [
      { ...verification, executionId: "relative" },
      { ...verification, executionId: "https://example.test/unsafe\\path" },
      { ...verification, verifier: { id: "relative" } },
      { ...verification, verifiedAt: "2026-02-30T12:00:00Z" },
      { ...verification, verdict: "pass" },
      { ...verification, checks: [{ name: "", status: "pass" }] },
      { ...verification, checks: [{ name: "integrity", status: "maybe" }] },
    ]) {
      const spy = vi.fn(signer);
      await expect(prepareExecutionVerification(input as never, spy))
        .rejects.toMatchObject({ code: "INVALID_ISSUANCE_INPUT" });
      expect(spy).not.toHaveBeenCalled();
    }
  });

  test.each([
    {
      field: "evaluator",
      value: "https://example.test/agents/evaluator#first#second",
    },
    {
      field: "evaluator",
      value: "https://user@name@example.test/agents/evaluator",
    },
    {
      field: "evaluator",
      value: "https://example.test/agents/[invalid]",
    },
    {
      field: "evaluator",
      value: "https://[not-an-ip-literal]/agents/evaluator",
    },
    {
      field: "evaluator",
      value: "https://example.test/agents/%ZZ",
    },
    {
      field: "evaluator",
      value: "https://example.test/agents/\uD800",
    },
    {
      field: "evaluator",
      value: "1https://example.test/agents/evaluator",
    },
    {
      field: "evaluator",
      value: "https://example.test:not-a-port/agents/evaluator",
    },
    {
      field: "evaluator",
      value: "https://example.test/agents/\"evaluator",
    },
    {
      field: "evaluator",
      value: "https://example.test/agents/evaluator?scope=<private>",
    },
    {
      field: "evaluator",
      value: "https://example.test/agents/evaluator#scope|private",
    },
    {
      field: "executionId",
      value: "urn:jinn:execution:primary#first#second",
    },
  ] as const)(
    "rejects malformed absolute IRI $field before signing: $value",
    async ({ field, value }) => {
      const spy = vi.fn(signer);
      const operation = field === "evaluator"
        ? prepareResultEvaluation({
          task: { name: "task", digest },
          results: [{ name: "result", digest }],
          evaluator: { id: value },
          evaluatedAt: "2026-07-24T12:00:00Z",
          verdict: "pass",
        }, spy)
        : prepareExecutionVerification({
          executionEvidenceDigest: digest,
          executionId: value,
          verifier: { id: "https://example.test/verifier" },
          verifiedAt: "2026-07-24T12:00:00Z",
          verdict: "verified",
        }, spy);

      await expect(operation).rejects.toMatchObject({
        code: "INVALID_ISSUANCE_INPUT",
      });
      expect(spy).not.toHaveBeenCalled();
    },
  );

  test.each([
    "https://user%40name@example.test:8443/agents/évaluator?scope=a?b#résumé?full",
    "https://example.test/agents/evaluator\u00a0primary",
    "urn:jinn:agent:évaluator",
  ])("preserves valid absolute IRI forms before signing: %s", async (id) => {
    const spy = vi.fn(signer);
    const prepared = await prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, spy);

    expect(prepared.value.statement.predicate.evaluator.id).toBe(id);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("rejects hostile normalized arrays before signing", async () => {
    const hostileArray = <T, U>(value: T, mapped: U) =>
      new Proxy([value], {
        get(target, property, receiver) {
          if (property === "map") return () => [mapped];
          return Reflect.get(target, property, receiver);
        },
      });
    const forbiddenReference = {
      name: "result",
      digest,
      extensions: { content: "PRIVATE RESULT BYTES" },
    };
    const accessorResults = Object.defineProperty(
      [forbiddenReference],
      "0",
      {
        configurable: true,
        enumerable: true,
        get: () => forbiddenReference,
      },
    );
    const baseInput = {
      task: { name: "task", digest },
      results: [{ name: "result", digest }] as const,
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass" as const,
    };
    const attempts = [
      (spy: DsseSigner) => prepareResultEvaluation({
        ...baseInput,
        results: hostileArray(forbiddenReference, {
          name: "result",
          digest: { sha256: "a".repeat(64) },
          content: "PRIVATE RESULT BYTES",
        }),
      } as never, spy),
      (spy: DsseSigner) => prepareResultEvaluation({
        ...baseInput,
        limitations: hostileArray(1, "sanitized"),
      } as never, spy),
      (spy: DsseSigner) => prepareResultEvaluation({
        ...baseInput,
        evidence: hostileArray({
          name: "report",
          digest,
          extensions: { content: "PRIVATE REPORT BYTES" },
        }, {
          name: "report",
          digest: { sha256: "a".repeat(64) },
          content: "PRIVATE REPORT BYTES",
        }),
      } as never, spy),
      (spy: DsseSigner) => prepareResultEvaluation({
        ...baseInput,
        measurements: hostileArray({
          name: "score",
          value: 1,
          extensions: { value: 2 },
        }, {
          name: "score",
          value: 2,
        }),
      } as never, spy),
      (spy: DsseSigner) => prepareExecutionVerification({
        executionEvidenceDigest: digest,
        executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
        verifier: { id: "https://example.test/verifier" },
        verifiedAt: "2026-07-24T12:00:00Z",
        verdict: "verified",
        checks: hostileArray({
          name: "integrity",
          status: "pass",
          extensions: { status: "fail" },
        }, {
          name: "integrity",
          status: "fail",
        }),
      } as never, spy),
      (spy: DsseSigner) => prepareResultEvaluation({
        ...baseInput,
        results: accessorResults,
      } as never, spy),
    ];

    for (const attempt of attempts) {
      const spy = vi.fn(signer);
      await expect(attempt(spy)).rejects.toMatchObject({
        code: "INVALID_ISSUANCE_INPUT",
      });
      expect(spy).not.toHaveBeenCalled();
    }
  });

  test("snapshots Proxy-backed input fields before validation and signing", async () => {
    const target = {
      task: { name: "task", digest },
      results: [{ name: "result", digest }] as const,
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass" as const,
    };
    let verdictReads = 0;
    const hostile = new Proxy(target, {
      get(object, property, receiver) {
        if (property === "verdict") {
          verdictReads += 1;
          return verdictReads === 1 ? "pass" : "fail";
        }
        return Reflect.get(object, property, receiver);
      },
    });
    const spy = vi.fn(signer);
    const prepared = await prepareResultEvaluation(hostile, spy);
    expect(prepared.value.statement.predicate.verdict).toBe("pass");
    expect(verdictReads).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);

    const accessor = Object.defineProperty(
      { ...target },
      "verdict",
      {
        enumerable: true,
        get: () => "pass",
      },
    );
    const blockedSigner = vi.fn(signer);
    await expect(
      prepareResultEvaluation(accessor as never, blockedSigner),
    ).rejects.toMatchObject({ code: "INVALID_ISSUANCE_INPUT" });
    expect(blockedSigner).not.toHaveBeenCalled();
  });

  test("snapshots signer array length and elements without invoking Proxy gets", async () => {
    let lengthReads = 0;
    const proxySigner: DsseSigner = async () =>
      new Proxy(
        [{ signature: new Uint8Array([1, 2, 3, 4]) }],
        {
          get(target, property, receiver) {
            if (property === "length") {
              lengthReads += 1;
              return lengthReads === 1 ? 1 : 0;
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );
    const prepared = await prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, proxySigner);
    expect(prepared.value.envelope.signatures).toHaveLength(1);
    expect(lengthReads).toBe(0);
  });

  test("keeps envelope, payload, and validated payload copies independent", async () => {
    const prepared = await prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, signer);
    const exactEnvelope = Uint8Array.from(prepared.envelopeBytes);
    const exactPayload = Uint8Array.from(prepared.payloadBytes);
    prepared.payloadBytes[0] ^= 1;
    expect(prepared.envelopeBytes).toEqual(exactEnvelope);
    expect(prepared.value.payloadBytes).toEqual(exactPayload);
    prepared.value.payloadBytes[0] ^= 1;
    expect(prepared.envelopeBytes).toEqual(exactEnvelope);
  });

  test("surfaces stable protocol diagnostics after signing", async () => {
    const validation = vi.spyOn(protocol, "validateResultEvaluation").mockReturnValueOnce({
      conforms: false,
      recordDigest: digest,
      diagnostics: [{
        code: "ATTESTATION_STATEMENT_INVALID",
        path: "/payload/predicate",
        message: "injected diagnostic",
      }],
    });
    await expect(prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, signer)).rejects.toMatchObject({
      code: "PROTOCOL_CONFORMANCE_FAILED",
      message: expect.stringContaining("ATTESTATION_STATEMENT_INVALID"),
    });
    await expect(prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, signer)).resolves.toBeDefined();
    validation.mockRestore();
  });
});
