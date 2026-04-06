#!/usr/bin/env tsx

import { execSync } from 'child_process';

type JsonRecord = Record<string, any>;

function usage(): never {
  console.error('Usage: yarn tsx scripts/validation/check-content-template-conformance.ts <requestId>');
  process.exit(1);
}

function extractInspectJson(raw: string): JsonRecord {
  const marker = '========== OUTPUT ==========';
  const markerIndex = raw.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('Could not find output marker in inspect-job-run output');
  }
  const tail = raw.slice(markerIndex + marker.length);
  const jsonStart = tail.indexOf('{');
  const jsonEnd = tail.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error('Could not locate JSON payload in inspect-job-run output');
  }
  return JSON.parse(tail.slice(jsonStart, jsonEnd + 1));
}

function extractJsonCandidates(text: string): any[] {
  if (!text || typeof text !== 'string') return [];
  const out: any[] = [];

  const fencedMatches = text.matchAll(/```json\s*([\s\S]*?)```/gi);
  for (const m of fencedMatches) {
    if (!m[1]) continue;
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // ignore
    }
  }

  let started = false;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let buffer = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!started) {
      if (ch === '{') {
        started = true;
        depth = 1;
        inString = false;
        escapeNext = false;
        buffer = '{';
      }
      continue;
    }

    buffer += ch;
    if (escapeNext) {
      escapeNext = false;
    } else if (ch === '\\' && inString) {
      escapeNext = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }

    if (started && depth === 0) {
      try {
        out.push(JSON.parse(buffer));
      } catch {
        // ignore
      }
      started = false;
      buffer = '';
      inString = false;
      escapeNext = false;
    }
  }
  return out;
}

function normalizeOutputFields(outputSpec: any): string[] {
  if (!outputSpec) return [];
  if (Array.isArray(outputSpec.fields)) {
    return outputSpec.fields
      .map((f: any) => {
        if (typeof f?.path === 'string') {
          const m = f.path.match(/^\$\.result\.([A-Za-z0-9_]+)$/);
          if (m?.[1]) return m[1];
        }
        return typeof f?.name === 'string' ? f.name : null;
      })
      .filter((x: string | null): x is string => Boolean(x));
  }
  return [];
}

function parseMaybeJson(value: unknown): any | null {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

function scoreCandidate(candidate: any, fields: string[]): number {
  if (!candidate || typeof candidate !== 'object') return -1;
  const root = resolveCandidateRoot(candidate);
  return fields.reduce((acc, field) => {
    if (root[field] !== undefined) return acc + 1;
    if (field === 'contentBody' && root.content !== undefined) return acc + 1;
    return acc;
  }, 0);
}

function resolveCandidateRoot(candidate: any): any {
  if (!candidate || typeof candidate !== 'object') return candidate;
  if (candidate.result && typeof candidate.result === 'object') return candidate.result;
  const parsedContent = parseMaybeJson(candidate.content);
  if (parsedContent && typeof parsedContent === 'object') return parsedContent;
  return candidate;
}

function extractStructuredResult(inspected: JsonRecord): JsonRecord {
  const deliveryContent = inspected.delivery?.ipfsContent || {};
  if (deliveryContent.result && typeof deliveryContent.result === 'object') {
    return deliveryContent.result;
  }

  const fields = normalizeOutputFields(inspected.request?.ipfsContent?.outputSpec);
  const candidates: any[] = [];
  candidates.push(...extractJsonCandidates(String(deliveryContent.output || '')));

  const toolCalls = Array.isArray(deliveryContent.telemetry?.toolCalls) ? deliveryContent.telemetry.toolCalls : [];
  for (const tc of toolCalls) {
    if (tc?.tool !== 'create_artifact' || tc?.success !== true) continue;
    const args = parseMaybeJson(tc.args);
    if (args) {
      candidates.push(args);
      const content = parseMaybeJson(args.content);
      if (content) candidates.push(content);
    }
  }

  let best: any = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, fields.length > 0 ? fields : ['contentBody', 'sourcesChecked', 'sourcesCited']);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (!best) return {};
  const root = resolveCandidateRoot(best);

  const result: JsonRecord = {};
  const targetFields = fields.length > 0 ? fields : ['contentBody', 'sourcesChecked', 'sourcesCited', 'sourceEvidence', 'formatCompliance'];
  for (const field of targetFields) {
    if (root[field] !== undefined) {
      result[field] = root[field];
      continue;
    }
    if (field === 'contentBody' && root.content !== undefined) {
      result[field] = root.content;
    }
  }
  return result;
}

function wordCount(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countSentences(text: string): number {
  if (!text) return 0;
  return text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean).length;
}

function hasSection(content: string, section: string): boolean {
  return content.toLowerCase().includes(section.toLowerCase());
}

function evaluate(inspected: JsonRecord): JsonRecord {
  const status =
    (typeof inspected.delivery?.ipfsContent?.status === 'string' && inspected.delivery.ipfsContent.status) ||
    (typeof inspected.request?.status === 'string' && inspected.request.status) ||
    (inspected.delivery ? 'COMPLETED' : (inspected.request?.delivered ? 'DELIVERED' : 'PENDING'));
  const nonTerminal = status === 'DELEGATING' || status === 'WAITING' || status === 'PENDING' || status === 'DELIVERED';
  const input = inspected.request?.ipfsContent?.input || {};
  const formatRules = input.formatRules || {};
  const sources = Array.isArray(input.sources) ? input.sources : [];
  const sourceCount = sources.length;
  const artifacts = Array.isArray(inspected.artifacts) ? inspected.artifacts : [];
  const telemetryToolCalls = Array.isArray(inspected.delivery?.ipfsContent?.telemetry?.toolCalls)
    ? inspected.delivery.ipfsContent.telemetry.toolCalls
    : [];
  const dispatchCalls = telemetryToolCalls.filter(
    (call: any) => (call?.tool === 'dispatch_new_job' || call?.tool === 'dispatch_existing_job') && call?.success === true
  ).length;

  if (nonTerminal) {
    return {
      requestId: inspected.request?.id,
      status,
      evaluable: false,
      reason: `Request status is ${status}; conformance should be checked on a terminal synthesis run.`,
      delegation: {
        dispatchCalls,
        desirable: true,
      },
      artifactsObserved: artifacts.length,
    };
  }

  const structured = extractStructuredResult(inspected);
  const contentBody = typeof structured.contentBody === 'string' ? structured.contentBody : '';
  const sourcesChecked = typeof structured.sourcesChecked === 'number' ? structured.sourcesChecked : 0;
  const sourcesCited = typeof structured.sourcesCited === 'number' ? structured.sourcesCited : 0;
  const sourceEvidence = Array.isArray(structured.sourceEvidence) ? structured.sourceEvidence : [];
  const contentWords = wordCount(contentBody);

  const goal1Checks: string[] = [];
  if (sourcesChecked >= sourceCount && sourceCount > 0) goal1Checks.push('sourcesChecked covers all input sources');
  if (sourceEvidence.length >= sourceCount && sourceCount > 0) goal1Checks.push('sourceEvidence entries cover all sources');
  if (dispatchCalls > 0) goal1Checks.push(`delegation observed (${dispatchCalls} dispatch call(s))`);
  const goal1Pass = sourceCount > 0 && sourcesChecked >= sourceCount && sourceEvidence.length >= sourceCount;

  const ruleFailures: string[] = [];
  if (typeof formatRules.minWords === 'number' && contentWords < formatRules.minWords) {
    ruleFailures.push(`word count ${contentWords} < minWords ${formatRules.minWords}`);
  }
  if (typeof formatRules.maxWords === 'number' && contentWords > formatRules.maxWords) {
    ruleFailures.push(`word count ${contentWords} > maxWords ${formatRules.maxWords}`);
  }
  if (formatRules.primaryStructure === 'bullets') {
    const bulletLines = contentBody.split('\n').filter((line) => /^\s*[-*]\s+/.test(line)).length;
    if (bulletLines < 3) ruleFailures.push('primaryStructure=bullets but too few bullet lines');
  }
  if (Array.isArray(formatRules.requiredSections)) {
    for (const section of formatRules.requiredSections) {
      if (typeof section === 'string' && section.trim().length > 0 && !hasSection(contentBody, section)) {
        ruleFailures.push(`missing required section: ${section}`);
      }
    }
  }
  if (typeof formatRules.executiveSummarySentences === 'number') {
    const firstParagraph = contentBody.split(/\n\s*\n/)[0] || '';
    const sentences = countSentences(firstParagraph);
    if (sentences < formatRules.executiveSummarySentences) {
      ruleFailures.push(
        `executive summary has ${sentences} sentence(s), expected >= ${formatRules.executiveSummarySentences}`
      );
    }
  }
  if (typeof formatRules.requiredCitations === 'number' && sourcesCited < formatRules.requiredCitations) {
    ruleFailures.push(`sourcesCited ${sourcesCited} < requiredCitations ${formatRules.requiredCitations}`);
  }

  const goal2Pass = contentBody.length > 0 && ruleFailures.length === 0;

  let qualityScore = 0;
  if (goal1Pass) qualityScore += 35;
  if (goal2Pass) qualityScore += 35;
  if (sourcesCited > 0) qualityScore += 15;
  if (contentWords >= 200) qualityScore += 15;
  const qualityPass = qualityScore >= 60;

  return {
    requestId: inspected.request?.id,
    status,
    evaluable: true,
    delegation: {
      dispatchCalls,
      desirable: true,
    },
    structuredResultPresent: Object.keys(structured).length > 0,
    structuredResult: {
      contentBodyPresent: contentBody.length > 0,
      sourcesChecked,
      sourcesCited,
      sourceEvidenceCount: sourceEvidence.length,
      wordCount: contentWords,
    },
    invariants: {
      'GOAL-001': {
        passed: goal1Pass,
        checks: goal1Checks,
      },
      'GOAL-002': {
        passed: goal2Pass,
        failedRules: ruleFailures,
      },
      'QUALITY-001': {
        passed: qualityPass,
        heuristicScore: qualityScore,
      },
    },
    artifactsObserved: artifacts.length,
  };
}

function main() {
  const requestId = process.argv[2];
  if (!requestId) usage();

  const raw = execSync(`yarn inspect-job-run ${requestId} --format=json 2>&1`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });

  const inspected = extractInspectJson(raw);
  const result = evaluate(inspected);
  const summary = result.invariants as JsonRecord | undefined;
  const overallPass = Boolean(
    result.evaluable !== false &&
    summary?.['GOAL-001']?.passed &&
    summary?.['GOAL-002']?.passed &&
    summary?.['QUALITY-001']?.passed
  );

  console.log(`Request: ${result.requestId}`);
  console.log(`Status: ${result.status}`);
  console.log(`Delegation calls: ${result.delegation.dispatchCalls}`);
  if (result.evaluable === false) {
    console.log(`Conformance: SKIPPED (${result.reason})`);
  } else {
    console.log(`GOAL-001: ${summary?.['GOAL-001']?.passed ? 'PASS' : 'FAIL'}`);
    console.log(`GOAL-002: ${summary?.['GOAL-002']?.passed ? 'PASS' : 'FAIL'}`);
    console.log(`QUALITY-001: ${summary?.['QUALITY-001']?.passed ? 'PASS' : 'FAIL'} (score=${summary?.['QUALITY-001']?.heuristicScore})`);
    console.log(`Overall: ${overallPass ? 'PASS' : 'FAIL'}`);
  }
  console.log('\nJSON:\n' + JSON.stringify(result, null, 2));
}

main();
