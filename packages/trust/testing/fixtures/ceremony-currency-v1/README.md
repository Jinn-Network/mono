# ceremony-currency-v1

Vectors for the ceremony currency text, `https://spec.jinn.network/profiles/ceremony-currency/v1`.

Each file is one case. Every ceremony is genuine: `messageBytesHex` is the profiled SIWE message serialized from `message`, and `signatureHex` is a real EIP-191 signature over it by the voucher account. The signing key is the secp256k1 key with value 1, a test value with no other use. Its address is `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`. Every case passes the checks that applied before this text: the signature recovers to the voucher, the message bytes are the serialized message, and the first two resources are the Agent IRI and the key. So each expected outcome turns on this text alone.

Every case is read under a deployment profile whose ceremony domain is `trust.jinn.network` and whose key-binding ceremony URI is `https://trust.jinn.network/ceremony/key-binding`.

| Field | Meaning |
| --- | --- |
| `input.record` | The fields of the key-binding record the case reads: `agent`, `key.didKey`, `voucher`, and the terms. |
| `input.ceremony` | The ceremony evidence, in the shape of `@jinn-network/trust-core/fixtures/ceremony-v1/eoa-siwe.json`. |
| `input.effectiveStart` | The record's effective start. |
| `input.cutover` | The deployment's terms cutover, when it names one. |
| `input.verifiedAt` | When the case is verified. A conforming verifier does not read it. |
| `expect` | `verified`, or `ceremony-verification-failed`. |

Every vector is built from the text. None is captured from a run.
