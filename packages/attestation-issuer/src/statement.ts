// SPDX-License-Identifier: Apache-2.0

import {
  EXECUTION_VERIFICATION_PREDICATE_TYPE,
  ExecutionVerificationStatementSchema,
  IN_TOTO_STATEMENT_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  ResultEvaluationStatementSchema,
  type ExecutionVerificationStatement,
  type ResultEvaluationStatement,
} from "@jinn-network/evidence-protocol";

import { invalidInput } from "./errors.js";
import {
  normalizeExecutionVerificationInput,
  normalizeResultEvaluationInput,
} from "./input.js";
import type {
  PrepareExecutionVerificationInput,
  PrepareResultEvaluationInput,
} from "./types.js";

function schemaFailure(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): never {
  const issue = error.issues[0];
  invalidInput(
    issue
      ? `Invalid Statement at /${issue.path.join("/")}: ${issue.message}`
      : "Invalid Statement.",
  );
}

export function buildResultEvaluationStatement(
  input: PrepareResultEvaluationInput,
): ResultEvaluationStatement {
  const normalized = normalizeResultEvaluationInput(input);
  const statement = {
    ...normalized.statementExtensions,
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [normalized.task, ...normalized.results],
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: normalized.predicate,
  } as ResultEvaluationStatement;
  const result = ResultEvaluationStatementSchema.safeParse(statement);
  if (!result.success) schemaFailure(result.error);
  return statement;
}

export function buildExecutionVerificationStatement(
  input: PrepareExecutionVerificationInput,
): ExecutionVerificationStatement {
  const normalized = normalizeExecutionVerificationInput(input);
  const statement = {
    ...normalized.statementExtensions,
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [normalized.subject],
    predicateType: EXECUTION_VERIFICATION_PREDICATE_TYPE,
    predicate: normalized.predicate,
  } as ExecutionVerificationStatement;
  const result = ExecutionVerificationStatementSchema.safeParse(statement);
  if (!result.success) schemaFailure(result.error);
  return statement;
}
