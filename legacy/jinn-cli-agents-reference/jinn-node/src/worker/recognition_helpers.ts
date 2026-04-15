import type { ProgressCheckpoint } from './recognition/progressCheckpoint.js';

export interface RecognitionLearning {
  sourceRequestId?: string;
  title?: string;
  insight?: string;
  actions?: string[];
  warnings?: string[];
  confidence?: string;
  artifactCid?: string;
}

export interface RecognitionPhaseResult {
  promptPrefix: string;
  learningsMarkdown?: string;
  rawLearnings?: unknown;
  searchQuery?: string;
  similarJobs?: Array<{
    requestId: string;
    score: number;
    jobName?: string;
  }>;
  initialSituation?: any | null;
  embeddingStatus?: 'success' | 'failed' | null;
  progressCheckpoint?: ProgressCheckpoint | null;
}

export function extractPromptSections(prompt: string | undefined | null): Record<string, string> {
  if (!prompt || typeof prompt !== 'string') return {};

  const sections: Record<string, string> = {};
  let current: string | null = null;

  for (const rawLine of prompt.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('# ')) {
      current = line.slice(2).trim();
      if (current && !sections[current]) sections[current] = '';
    } else if (current) {
      sections[current] = sections[current] ? `${sections[current]}\n${line}` : line;
    }
  }

  for (const key of Object.keys(sections)) {
    sections[key] = sections[key].trim();
  }

  return sections;
}

export function sanitizeMarkdownText(value: unknown, max = 320): string {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildDefaultQueryText(jobName: string | undefined, sections: Record<string, string>): string {
  const parts: string[] = [];
  if (jobName) parts.push(jobName);
  if (sections['Objective']) parts.push(sections['Objective']);
  if (sections['Context']) parts.push(sections['Context']);
  if (sections['Acceptance Criteria']) parts.push(`Acceptance Criteria: ${sections['Acceptance Criteria']}`);
  if (sections['Constraints']) parts.push(`Constraints: ${sections['Constraints']}`);
  return sanitizeMarkdownText(parts.join(' | '), 600);
}

export function parseRecognitionJson(output: string): any | null {
  if (!output || typeof output !== 'string') return null;
  const trimmed = output.trim();

  const fences = trimmed.match(/```json([\s\S]*?)```/i);
  if (fences && fences[1]) {
    try {
      return JSON.parse(fences[1]);
    } catch {
      // fall through
    }
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const candidate = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
  }

  return null;
}

export function normalizeLearnings(raw: any): RecognitionLearning[] {
  const listCandidates = [
    raw?.learnings,
    raw?.data?.learnings,
    raw?.result?.learnings,
  ].find((candidate) => Array.isArray(candidate)) as any[] | undefined;

  if (!listCandidates || !Array.isArray(listCandidates)) return [];

  const pickArray = (value: any): string[] => {
    if (Array.isArray(value)) {
      return value
        .map((item) => sanitizeMarkdownText(item, 180))
        .filter((item) => item.length > 0);
    }
    return [];
  };

  return listCandidates
    .map((item) => {
      const source =
        item?.sourceRequestId ||
        item?.source_request_id ||
        item?.nodeId ||
        item?.node_id ||
        item?.requestId ||
        item?.situationRequestId;

      const title =
        item?.title ||
        item?.heading ||
        item?.summary ||
        item?.insightTitle ||
        item?.name;

      const insight =
        item?.insight ||
        item?.description ||
        item?.learning ||
        item?.summary ||
        item?.analysis;

      const actions =
        pickArray(item?.actions) ||
        pickArray(item?.action_items) ||
        pickArray(item?.recommendations) ||
        pickArray(item?.steps);

      const warnings = pickArray(item?.warnings || item?.risks || item?.watchouts);

      const confidence =
        item?.confidence ||
        item?.confidence_level ||
        item?.confidenceLevel;

      const artifactCid = item?.artifactCid || item?.artifact_cid || item?.cid;

      return {
        sourceRequestId: sanitizeMarkdownText(source, 80) || undefined,
        title: sanitizeMarkdownText(title, 140) || undefined,
        insight: sanitizeMarkdownText(insight, 280) || undefined,
        actions: actions.slice(0, 4),
        warnings: warnings.slice(0, 3),
        confidence: sanitizeMarkdownText(confidence, 40) || undefined,
        artifactCid: sanitizeMarkdownText(artifactCid, 80) || undefined,
      } as RecognitionLearning;
    })
    .filter((learning) => learning.insight || (learning.actions && learning.actions.length > 0));
}

export function formatRecognitionMarkdown(learnings: RecognitionLearning[]): string {
  if (!Array.isArray(learnings) || learnings.length === 0) return '';

  const items = learnings.map((learning) => {
    const title = learning.title || learning.insight || 'Relevant pattern';
    const source = learning.sourceRequestId ? ` (source: ${learning.sourceRequestId})` : '';
    const fragments: string[] = [];

    if (learning.insight) fragments.push(`Insight: ${learning.insight}`);
    if (learning.actions && learning.actions.length > 0) fragments.push(`Actions: ${learning.actions.join('; ')}`);
    if (learning.warnings && learning.warnings.length > 0) fragments.push(`Watchouts: ${learning.warnings.join('; ')}`);
    if (learning.confidence) fragments.push(`Confidence: ${learning.confidence}`);

    return `- **${title}**${source}${fragments.length > 0 ? ` — ${fragments.join(' | ')}` : ''}`;
  });

  return ['---', '## Recognition Learnings', ...items, '---', ''].join('\n');
}

export function buildRecognitionPrompt(jobOverviewLines: string[], defaultQueryText: string): string {
  const overview = jobOverviewLines.map((line) => `- ${line}`).join('\n');
  const queryLine = `- Default query_text: ${defaultQueryText || '(construct from job objective and context)'}`;

  return `
You are the Recognition Scout for the Venture. Your mission is **Recognize → Analyze → Synthesize** before the execution agent runs.

### Critical Instructions (Must Follow All Steps)
1. **Recognize:** Understand the incoming job using the overview below.
2. **Analyze:** Call \`search_similar_situations\` with a concise summary of this job (you may start from the default query text below). This will return a list of similar past jobs with their request IDs.
3. **Inspect (MANDATORY):** You MUST call \`get_details\` for EACH request ID returned by \`search_similar_situations\`. The tool will return the full request data including:
   - \`artifacts.items[]\` array containing SITUATION artifacts
   - Each SITUATION artifact includes \`ipfsContent\` with the full situation JSON
   - The situation JSON contains \`execution.trace\`, \`job.objective\`, \`context\`, and \`meta.recognition.learnings\`
   Study these execution traces, tool usage patterns, and any embedded learnings from past recognition phases.
4. **Synthesize:** Based on your inspection of the SITUATION artifacts, distill concrete, actionable learnings that would help the execution agent succeed on this job. Focus on:
   - Strategies that worked or failed in similar jobs
   - Common pitfalls or edge cases encountered
   - Tool usage patterns (which tools, in what order, with what parameters)
   - Deliverable expectations and formats
   If the similar jobs have empty execution traces or you cannot extract meaningful patterns, return empty learnings.

### Job Overview
${overview}
${queryLine}

### Output Requirements
- You MUST call \`get_details\` after \`search_similar_situations\` before generating output.
- Respond with **JSON only** (no prose, no Markdown).
- Use this exact schema:
\`\`\`json
{
  "learnings": [
    {
      "sourceRequestId": "0x...",
      "title": "Short headline for the learning",
      "insight": "Actionable guidance grounded in the past run",
      "actions": ["Specific recommended action 1", "Optional follow-up action 2"],
      "warnings": ["Potential pitfall or risk to avoid"],
      "confidence": "high | medium | low",
      "artifactCid": "bafy..."
    }
  ]
}
\`\`\`
- If no relevant situations are found OR all SITUATION artifacts lack meaningful execution data, return \`{"learnings": []}\`.
- Prioritize clarity and actionable specificity over generic advice.
`.trim();
}

export function buildRecognitionPromptWithArtifacts(
  jobOverviewLines: string[], 
  defaultQueryText: string,
  situationArtifacts: Array<{ sourceRequestId: string, score: number, situation: any }>
): string {
  const overview = jobOverviewLines.map((line) => `- ${line}`).join('\n');
  
  // Format artifacts as structured context
  const artifactsContext = situationArtifacts.map((art, idx) => {
    const situation = art.situation;
    const trace = situation?.execution?.trace || [];
    const traceFormatted = trace.length > 0 
      ? trace.map((step: any, i: number) => `   ${i + 1}. **${step.tool || 'unknown'}**: ${sanitizeMarkdownText(step.result_summary || '', 200)}`).join('\n')
      : '   (No execution trace available)';
    
    const pastLearnings = situation?.meta?.recognition?.learnings;
    const learningsFormatted = pastLearnings && Array.isArray(pastLearnings.learnings) && pastLearnings.learnings.length > 0
      ? JSON.stringify(pastLearnings.learnings, null, 2)
      : '   (No past recognition learnings)';

    return `
### Similar Job ${idx + 1}: ${situation?.job?.jobName || art.sourceRequestId}
- **Request ID:** ${art.sourceRequestId}
- **Similarity Score:** ${(art.score * 100).toFixed(1)}%
- **Objective:** ${sanitizeMarkdownText(situation?.job?.objective || 'N/A', 280)}
- **Status:** ${situation?.execution?.status || 'UNKNOWN'}

**Execution Trace:**
${traceFormatted}

**Final Output Summary:**
${sanitizeMarkdownText(situation?.execution?.finalOutputSummary || '(No summary)', 400)}

**Past Recognition Learnings:**
${learningsFormatted}
`;
  }).join('\n---\n');

  return `
You are the Recognition Scout for the Venture. Your task is to synthesize actionable learnings from similar past jobs to help the current job succeed.

### Current Job
${overview}

### Similar Past Jobs Found
The system has identified ${situationArtifacts.length} similar past job(s) based on semantic similarity to your current objective. Study their execution patterns below:

${artifactsContext}

---

### Your Task
Analyze the execution traces, tool usage patterns, and outcomes above. Synthesize concrete, actionable learnings that would help the current job succeed.

**CRITICAL: Frame your learnings as HISTORICAL OBSERVATIONS, not generic advice.**

Focus on:
- **Observed Tool Usage:** Which specific tools were CALLED (not "should be called")? In what sequence? How many times?
- **Observed Patterns that Worked:** What did successful jobs DO (actual tool calls, not narratives)?
- **Observed Patterns that Failed:** What did failed jobs DO that should be avoided?
- **Common pitfalls:** What edge cases or errors were encountered?
- **Deliverable formats:** What artifacts were created? What format worked well?

**DO NOT give generic advice like "Use dispatch_new_job to create child jobs".**
**DO describe what actually happened: "Called dispatch_new_job 3 times before any web_fetch calls"**

### System Blood Written Rules
Common issues encountered in past runs:
- **CODE_METADATA_REPO_ROOT errors:** For research-only jobs (no code changes), always use \`skipBranch: true\` in dispatch_new_job to avoid git branch creation errors
- **Transaction not found:** Blockchain RPC transient errors - retry dispatch calls that fail with this error
- **Duplicate dispatch counting:** System tracks unique job definitions, not total dispatch attempts - retries are normal

### Output Requirements
- Respond with **JSON only** (no prose, no Markdown).
- Use this exact schema:
\`\`\`json
{
  "learnings": [
    {
      "sourceRequestId": "0x...",
      "title": "Short headline describing what was observed",
      "insight": "What happened in past jobs (e.g., 'These jobs called dispatch_new_job early and succeeded')",
      "actions": ["Observed behavior (e.g., 'Called dispatch_new_job twice', 'Created artifact before dispatching')", "Another observed pattern"],
      "warnings": ["Observed failure pattern to avoid (e.g., 'Jobs that only described delegation failed')"],
      "confidence": "high | medium | low",
      "artifactCid": "bafy..."
    }
  ]
}
\`\`\`
- If no actionable patterns emerge from the similar jobs, return \`{"learnings": []}\`.
- **CRITICAL**: The "actions" field must describe OBSERVED TOOL CALLS from past jobs, not generic recommendations.
- Example GOOD action: "Called dispatch_new_job 3 times in sequence before finalization"
- Example BAD action: "Use dispatch_new_job to create child jobs"
`.trim();
}
