// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { recordDigest } from "@jinn-network/trust-core";

const OWNER = "@jinn-network/task-execution-profiles";

/**
 * Documents the specification publishes and records cite by digest: task profiles and parser
 * semantics. The bytes are not copied here. They are the files `@jinn-network/task-execution-profiles`
 * already ships, a runtime dependency of this package, whose `check:documents` holds them to their
 * builders. The specification imported the same bytes, and each digest below equals the entry for
 * that document in the signed `sealed-platform-v1` manifest of specification release v0.1.0.
 *
 * Those documents are sealed, so a change is a new document under a new name, and it arrives here
 * as a new pin. `published-documents.test.ts` fails if a file drifts from its pin or if the owner
 * ships a document with no pin.
 */
export const PUBLISHED_DOCUMENTS: readonly { readonly path: string; readonly sha256: string }[] = [
  { path: "profiles/task-profiles/binary-judgment/2.0/profile.json", sha256: "ebb34d8362e2cc3135847a5ad6f3ee3d9c2d9922a2b827aa9dfcbaf440b22557" },
  { path: "profiles/task-profiles/evaluation-task/1.0/profile.json", sha256: "5131bab4aa41743eb625963d12b222f814c8367e08967baecef5d0af932aab1e" },
  { path: "profiles/task-profiles/prediction-forecast/1.0/profile.json", sha256: "7e451784e0f25caba25333b941368e78f781669bc03f6d1b59f8f4215ddc3ef9" },
  { path: "profiles/task-profiles/repository-work/1.0/profile.json", sha256: "4a920949b7c6f7eea430ca0b8aca530db10135b967638dc5869734dd5bb51ec5" },
  { path: "profiles/task-profile/v1/profile.json", sha256: "dd511d9444658dad75252f7bd6ffb448a6d8cdd4967d35d37503e92b96515020" },
  { path: "profiles/binary-judgment/parsers/binary-accept-reject/1.0.0/semantics.json", sha256: "02aa652770de9e74415cd206c8741b6148e3ea82c21773983a6d8c66030d0073" },
  { path: "profiles/binary-judgment/parsers/binary-complete-json-label/1.0.0/semantics.json", sha256: "db1215184eb98aec6fe26f5412e6e823fbd19f75c5c080fbb58ecd1968503f4b" },
  { path: "profiles/binary-judgment/parsers/binary-complete-json-label/2.0.0/semantics.json", sha256: "88545378ce165666102edc22393bbe87950c3a48d325fe142fab0f1c319a1916" },
  { path: "profiles/binary-judgment/parsers/binary-correct-wrong/1.0.0/semantics.json", sha256: "2dd7e73c9ee063edb00fe7859821eee1122b483d4bd70568aebb046a6983ac4c" },
  { path: "profiles/binary-judgment/parsers/binary-evermem-json-label/1.0.0/semantics.json", sha256: "4834ba3e6c817c560c72afb93a4a5b56c0cf654cf6ff1012843ea7675f507942" },
  { path: "profiles/binary-judgment/parsers/binary-evermem-json-label/2.0.0/semantics.json", sha256: "f3d9ca6df8bfc263e64e25500c300d24124175c1c76596effc8be1c3780c1fb6" },
  { path: "profiles/binary-judgment/parsers/binary-json-verdict/1.0.0/semantics.json", sha256: "543a71887f3ae95b0aede4513af3fdeadfc706c7a86f93452e3272d7ccdd2201" },
  { path: "profiles/binary-judgment/parsers/binary-judgment-evaluation/1.0.0/semantics.json", sha256: "3568ee132ece234c15b7f9b6b4a7a954aefc2c417e17f2fde91729a7240bb343" },
  { path: "profiles/binary-judgment/parsers/binary-judgment-evaluation/2.0.0/semantics.json", sha256: "838a8e4d21893524cba10e5a282397b334a67fe9bc516d53ae20fd4f2b915038" },
  { path: "profiles/binary-judgment/parsers/binary-label-in-prose/1.0.0/semantics.json", sha256: "d53d23afc8734090c8d54c39de8105ead37c3ecad0cf0f454e97a535e5937f10" },
  { path: "profiles/binary-judgment/parsers/binary-mem0-json-label/1.0.0/semantics.json", sha256: "7453de03b2614395b6cd223f6bfb104d924dfcbd05006d38328307bd7a1d825a" },
  { path: "profiles/binary-judgment/parsers/binary-mem0-json-label/2.0.0/semantics.json", sha256: "89e4d1037d2e80c47867ca867cafeb91ff9d6a16125c18062ffb3d23e477b406" },
  { path: "profiles/binary-judgment/parsers/binary-strict-json-label/1.0.0/semantics.json", sha256: "e5c723c97a55d631d26a8da2badea0df755943987cd679acf7bad7653f48dca6" },
  { path: "profiles/binary-judgment/parsers/binary-strict-json-label/2.0.0/semantics.json", sha256: "f43f988181ed8490fb85824b1c0ed7d991f5b050097a6874fccf750d815593ca" },
  { path: "profiles/binary-judgment/parsers/binary-yes-no/1.0.0/semantics.json", sha256: "1b99469a195fee154c27d0c3b219da7778e1b8f4210bd773350d107c459b7949" },
];

/**
 * The carried documents, for the `published` option of `checkRecordSet`. Unlike the checks this
 * reads files, from the installed dependency. A file that is missing or does not hash to its pin is
 * left out, so it resolves nothing and the reference it would have met stays dangling.
 */
export function loadPublishedDocuments(): readonly Uint8Array[] {
  const require = createRequire(import.meta.url);
  return PUBLISHED_DOCUMENTS.flatMap(({ path, sha256 }) => {
    try {
      const bytes = new Uint8Array(readFileSync(require.resolve(`${OWNER}/${path}`)));
      return recordDigest(bytes) === `sha256:${sha256}` ? [bytes] : [];
    } catch {
      return [];
    }
  });
}
