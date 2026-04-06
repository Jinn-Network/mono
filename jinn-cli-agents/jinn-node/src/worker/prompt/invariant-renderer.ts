/**
 * Invariant Renderer
 *
 * Converts structured invariants to natural language prose for agent consumption.
 * The agent sees readable text, not raw JSON structure.
 */

import type {
  Invariant,
  FloorInvariant,
  CeilingInvariant,
  RangeInvariant,
  BooleanInvariant,
  InvariantExamples,
  UnifiedBlueprint,
  MeasurementInfo,
  BlueprintContext,
} from './types.js';

/**
 * Semantic Layer Types
 *
 * Invariants are grouped into three layers based on serial position effects:
 * - IMMEDIATE (primacy position): Time-sensitive coordination actions
 * - MISSION (middle): What to accomplish - goals and strategy
 * - PROTOCOL (recency position): How to operate - reference material
 */
type SemanticLayer = 'immediate' | 'mission' | 'protocol';

interface LayerConfig {
  prefixes: string[];
  header: string;
  description: string;
  includeAssessment: boolean;
}

const LAYER_CONFIG: Record<SemanticLayer, LayerConfig> = {
  immediate: {
    prefixes: ['COORD', 'QUAL', 'RECOV'],
    header: 'IMMEDIATE: Coordination Required',
    description: 'Address these before starting new work:',
    includeAssessment: true,
  },
  mission: {
    prefixes: ['JOB', 'GOAL', 'OUT', 'STRAT', 'ORCH', 'DAO'],
    header: 'MISSION: Your Goals',
    description: 'What you must achieve or delegate:',
    includeAssessment: true,
  },
  protocol: {
    prefixes: ['SYS', 'STATE', 'TOOL', 'CYCLE', 'LEARN'],
    header: 'PROTOCOL: Operating Principles',
    description: 'How you operate throughout this session:',
    includeAssessment: false, // Examples only, no assessment
  },
};

const LAYER_ORDER: SemanticLayer[] = ['immediate', 'mission', 'protocol'];

/**
 * Get the semantic layer for an invariant based on its ID prefix
 */
function getLayerForInvariant(id: string): SemanticLayer {
  const prefix = id.split('-')[0];
  for (const [layer, config] of Object.entries(LAYER_CONFIG)) {
    if (config.prefixes.includes(prefix)) {
      return layer as SemanticLayer;
    }
  }
  return 'protocol'; // default
}

/**
 * Render a single invariant to prose
 *
 * Output format:
 * ```
 * [ID] (TYPE) - constraint statement
 * → Assessment: [how to measure]
 * → To measure: create_measurement({ invariant_id: 'ID', ... })
 * ```
 *
 * With optional examples:
 * ```
 * [ID] (TYPE) - constraint statement
 * → Assessment: [how to measure]
 * → To measure: create_measurement({ invariant_id: 'ID', ... })
 *   ✓ Do: [example]
 *   ✗ Don't: [example]
 * ```
 */
export function renderInvariant(inv: Invariant): string {
  const lines: string[] = [];
  const systemInvariant = isSystemInvariant(inv);

  // Line 1: ID (prominent), type badge, and constraint statement
  const constraintStatement = renderConstraintStatement(inv);
  lines.push(`[${inv.id}] (${inv.type}) - ${constraintStatement}`);

  // Line 2: Assessment (how to measure)
  lines.push(`→ Assessment: ${inv.assessment}`);

  // Line 3: Measurement hint with exact ID (non-SYS only)
  if (!systemInvariant) {
    lines.push(renderMeasurementHint(inv));
  }

  // Optional: Examples
  if (inv.examples) {
    lines.push(...renderExamples(inv.examples));
  }

  return lines.join('\n');
}

/**
 * Render the constraint statement based on invariant type
 */
function renderConstraintStatement(inv: Invariant): string {
  switch (inv.type) {
    case 'FLOOR':
      return `${inv.metric} must be at least ${inv.min}`;

    case 'CEILING':
      return `${inv.metric} must be at most ${inv.max}`;

    case 'RANGE':
      return `${inv.metric} must be between ${inv.min} and ${inv.max}`;

    case 'BOOLEAN':
      return inv.condition;

    default:
      // Exhaustive check - TypeScript will error if we miss a type
      const _exhaustive: never = inv;
      throw new Error(`Unknown invariant type: ${(_exhaustive as Invariant).type}`);
  }
}

function renderMeasurementHint(inv: Invariant): string {
  switch (inv.type) {
    case 'FLOOR':
      return `→ To measure: create_measurement({ invariant_type: 'FLOOR', invariant_id: '${inv.id}', measured_value: <number>, min_threshold: ${inv.min}, context: '...' })`;
    case 'CEILING':
      return `→ To measure: create_measurement({ invariant_type: 'CEILING', invariant_id: '${inv.id}', measured_value: <number>, max_threshold: ${inv.max}, context: '...' })`;
    case 'RANGE':
      return `→ To measure: create_measurement({ invariant_type: 'RANGE', invariant_id: '${inv.id}', measured_value: <number>, min_threshold: ${inv.min}, max_threshold: ${inv.max}, context: '...' })`;
    case 'BOOLEAN':
      return `→ To measure: create_measurement({ invariant_type: 'BOOLEAN', invariant_id: '${inv.id}', passed: <true|false>, context: '...' })`;
    default: {
      const _exhaustive: never = inv;
      throw new Error(`Unknown invariant type: ${(_exhaustive as Invariant).type}`);
    }
  }
}

/**
 * Render examples as indented lines (legacy format with Unicode)
 */
function renderExamples(examples: InvariantExamples): string[] {
  const lines: string[] = [];

  if (examples.do && examples.do.length > 0) {
    for (const example of examples.do) {
      lines.push(`  ✓ Do: ${example}`);
    }
  }

  if (examples.dont && examples.dont.length > 0) {
    for (const example of examples.dont) {
      lines.push(`  ✗ Don't: ${example}`);
    }
  }

  return lines;
}

/**
 * Render examples in clean format without Unicode symbols
 */
function renderExamplesClean(examples: InvariantExamples): string[] {
  const lines: string[] = [];

  if (examples.do && examples.do.length > 0) {
    lines.push(`Good practice: ${examples.do.join('; ')}`);
  }

  if (examples.dont && examples.dont.length > 0) {
    lines.push(`Avoid: ${examples.dont.join('; ')}`);
  }

  return lines;
}

/**
 * Render constraint as an instructional statement
 */
function renderConstraintAsInstruction(inv: Invariant): string {
  switch (inv.type) {
    case 'FLOOR':
      return `Your goal: ${inv.metric} of at least ${inv.min}`;

    case 'CEILING':
      return `Your goal: ${inv.metric} of at most ${inv.max}`;

    case 'RANGE':
      return `Your goal: ${inv.metric} between ${inv.min} and ${inv.max}`;

    case 'BOOLEAN':
      return inv.condition;

    default:
      // Exhaustive check
      const _exhaustive: never = inv;
      throw new Error(`Unknown invariant type: ${(_exhaustive as Invariant).type}`);
  }
}

/**
 * Render multiple invariants to a single prose block
 *
 * Groups invariants by prefix (SYS-, GOAL-, COORD-, etc.) with headers.
 */
export function renderInvariants(invariants: Invariant[]): string {
  if (invariants.length === 0) {
    return 'No invariants defined.';
  }

  // Group invariants by prefix
  const groups = groupByPrefix(invariants);

  const sections: string[] = [];

  for (const [prefix, group] of Object.entries(groups)) {
    const header = getPrefixHeader(prefix);
    const renderedInvariants = group.map(renderInvariant).join('\n\n');
    sections.push(`## ${header}\n\n${renderedInvariants}`);
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Group invariants by ID prefix
 */
function groupByPrefix(invariants: Invariant[]): Record<string, Invariant[]> {
  const groups: Record<string, Invariant[]> = {};

  for (const inv of invariants) {
    const prefix = inv.id.split('-')[0] || 'OTHER';
    if (!groups[prefix]) {
      groups[prefix] = [];
    }
    groups[prefix].push(inv);
  }

  return groups;
}

/**
 * Get human-readable header for a prefix
 */
function getPrefixHeader(prefix: string): string {
  const headers: Record<string, string> = {
    SYS: 'System Protocol',
    GOAL: 'Goals',
    JOB: 'Job Requirements',
    COORD: 'Coordination',
    STATE: 'State',
    QUAL: 'Quality',
    LEARN: 'Learnings',
    STRAT: 'Strategy',
    RECOV: 'Recovery',
    TOOL: 'Tooling',
    CYCLE: 'Cycle',
    OUT: 'Output',
    ORCH: 'Orchestration',
    DAO: 'DAO Goals',
  };

  return headers[prefix] || prefix;
}

/**
 * Render a single invariant for compact display (single line)
 *
 * Use this for logs, telemetry, and compact views.
 */
export function renderInvariantCompact(inv: Invariant): string {
  const constraintStatement = renderConstraintStatement(inv);
  return `[${inv.id}] (${inv.type}) - ${constraintStatement}`;
}

/**
 * Render a single invariant for a specific layer
 *
 * - IMMEDIATE and MISSION layers: instructional format with assessment
 * - PROTOCOL layer: reference format with examples only (no assessment)
 */
function renderInvariantForLayer(inv: Invariant, includeAssessment: boolean): string {
  const lines: string[] = [];

  // Line 1: ID alone
  lines.push(inv.id);

  // Line 2: Constraint as instruction
  lines.push(renderConstraintAsInstruction(inv));

  // Assessment (only for immediate/mission layers)
  if (includeAssessment && inv.assessment) {
    lines.push('');  // blank line for separation
    lines.push(`Assess: ${inv.assessment}`);
  }

  // Examples (clean format)
  if (inv.examples) {
    lines.push('');  // blank line for separation
    lines.push(...renderExamplesClean(inv.examples));
  }

  return lines.join('\n');
}

/**
 * Render invariants grouped by semantic layer
 *
 * Three-layer structure based on serial position effects:
 * 1. IMMEDIATE (top/primacy): Time-sensitive coordination - address first
 * 2. MISSION (middle): Goals and strategy - what to accomplish
 * 3. PROTOCOL (bottom/recency): Operating principles - reference material
 *
 * Empty layers are omitted. Assessments only shown for IMMEDIATE and MISSION.
 */
export function renderInvariantsByLayer(
  invariants: Invariant[],
  context?: BlueprintContext
): string {
  if (invariants.length === 0) {
    return 'No invariants defined.';
  }

  const measurementMap = new Map<string, MeasurementInfo>();
  if (context?.measurements) {
    for (const m of context.measurements) {
      measurementMap.set(m.invariantId, m);
    }
  }

  // Group invariants by layer
  const layers: Record<SemanticLayer, Invariant[]> = {
    immediate: [],
    mission: [],
    protocol: [],
  };

  for (const inv of invariants) {
    const layer = getLayerForInvariant(inv.id);
    layers[layer].push(inv);
  }

  // Render each non-empty layer
  const sections: string[] = [];

  for (const layer of LAYER_ORDER) {
    if (layers[layer].length === 0) continue;

    const config = LAYER_CONFIG[layer];
    const rendered = layers[layer]
      .map((inv) => {
        if (layer === 'mission') {
          // Directive-based rendering: concise status (IN BOUNDS/VIOLATED/UNMEASURED)
          const measurement = measurementMap.get(inv.id);
          return renderInvariantAsDirective(inv, measurement);
        }
        return renderInvariantForLayer(inv, config.includeAssessment);
      })
      .join('\n\n');
    sections.push(`## ${config.header}\n\n${config.description}\n\n${rendered}`);
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Render a complete blueprint to prose for agent consumption
 *
 * This is the main entry point for converting a structured blueprint
 * to agent-readable prose. The structured blueprint is preserved for
 * machine readability; this function produces the human-readable version.
 */
export function renderBlueprintToProse(blueprint: UnifiedBlueprint): string {
  const sections: string[] = [];

  // Render invariants by semantic layer
  const invariantsProse = renderInvariantsByLayer(blueprint.invariants, blueprint.context);
  sections.push(invariantsProse);

  const contextProse = renderContextAsProse(blueprint.context);
  if (contextProse !== 'No context available.') {
    sections.push(`## CONTEXT: Reference\n\n${contextProse}`);
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Type-specific renderers for when you need fine-grained control
 */
export const TypeRenderers = {
  floor: (inv: FloorInvariant): string =>
    `${inv.metric} must be at least ${inv.min}`,

  ceiling: (inv: CeilingInvariant): string =>
    `${inv.metric} must be at most ${inv.max}`,

  range: (inv: RangeInvariant): string =>
    `${inv.metric} must be between ${inv.min} and ${inv.max}`,

  boolean: (inv: BooleanInvariant): string => inv.condition,
};

// =============================================================================
// Directive-Based Rendering
// =============================================================================

/**
 * Render a single invariant as a concise directive with status.
 *
 * Output format:
 * ```
 * GOAL-001
 * content_quality must be at least 70
 * Status: IN BOUNDS (82, measured 6h ago)
 * ```
 *
 * When violated:
 * ```
 * GOAL-002
 * weekly_posts must be at least 1
 * Status: VIOLATED (0, measured 2d ago)
 * ```
 *
 * When unmeasured:
 * ```
 * GOAL-003
 * SEO coverage must be satisfied
 * Status: UNMEASURED
 * ```
 */
export function renderInvariantAsDirective(
  inv: Invariant,
  measurement?: MeasurementInfo
): string {
  const lines: string[] = [];

  // Line 1: ID
  lines.push(inv.id);

  // Line 2: Constraint statement
  lines.push(renderConstraintStatement(inv));

  // Line 3: Status
  if (measurement) {
    const statusLabel = measurement.passed ? 'IN BOUNDS' : 'VIOLATED';
    const valueStr = renderMeasurementValue(inv, measurement);
    const ageStr = measurement.age ? `, measured ${measurement.age}` : '';
    lines.push(`Status: ${statusLabel} (${valueStr}${ageStr})`);
  } else {
    lines.push('Status: UNMEASURED');
  }

  return lines.join('\n');
}

/**
 * Render measurement value for directive status line
 */
function renderMeasurementValue(inv: Invariant, m: MeasurementInfo): string {
  switch (inv.type) {
    case 'BOOLEAN':
      return m.passed ? 'PASSED' : 'FAILED';
    default:
      return typeof m.value === 'number' ? String(m.value) : '?';
  }
}

// =============================================================================
// Measurement-Aware Rendering (legacy, used by non-layer renders)
// =============================================================================

/**
 * Render a single invariant with its latest measurement status
 *
 * Output format (with measurement):
 * ```
 * [ID] (TYPE) - constraint statement
 * → Assessment: [how to measure]
 * → Latest measurement: [value] (PASSING/FAILING) - [age]
 *   "[context]"
 * ```
 *
 * Or if no measurement:
 * ```
 * [ID] (TYPE) - constraint statement
 * → Assessment: [how to measure]
 * → No measurement yet
 * → To measure: create_measurement({ invariant_id: 'ID', invariant_type: 'TYPE', ... })
 * ```
 */
export function renderInvariantWithMeasurement(
  inv: Invariant,
  measurement?: MeasurementInfo
): string {
  const lines: string[] = [];
  const systemInvariant = isSystemInvariant(inv);

  // Line 1: ID (prominent), type badge, and constraint statement
  const constraintStatement = renderConstraintStatement(inv);
  lines.push(`[${inv.id}] (${inv.type}) - ${constraintStatement}`);

  // Line 2: Assessment (how to measure)
  lines.push(`→ Assessment: ${inv.assessment}`);

  // Line 3: Measurement status (non-SYS only)
  if (!systemInvariant) {
    if (measurement) {
      const measurementLine = renderMeasurementStatus(inv, measurement);
      lines.push(`→ ${measurementLine}`);

      // Line 4: Context quote (if available)
      if (measurement.context) {
        lines.push(`  "${measurement.context}"`);
      }
    } else {
      lines.push(`→ No measurement yet`);
      // Show measurement hint when not yet measured
      lines.push(renderMeasurementHint(inv));
    }
  }

  // Optional: Examples (only if no measurement, to keep it concise)
  if (!measurement && inv.examples) {
    lines.push(...renderExamples(inv.examples));
  }

  return lines.join('\n');
}

function isSystemInvariant(inv: Invariant): boolean {
  return inv.id.startsWith('SYS-');
}

/**
 * Render measurement status based on invariant type
 */
function renderMeasurementStatus(inv: Invariant, m: MeasurementInfo): string {
  const status = m.passed ? 'PASSING' : 'FAILING';
  const age = m.age ? ` - ${m.age}` : '';

  switch (inv.type) {
    case 'FLOOR': {
      const floorInv = inv as FloorInvariant;
      const value = typeof m.value === 'number' ? m.value : '?';
      return `Latest measurement: ${value} (>= ${floorInv.min}) ${status}${age}`;
    }

    case 'CEILING': {
      const ceilingInv = inv as CeilingInvariant;
      const value = typeof m.value === 'number' ? m.value : '?';
      return `Latest measurement: ${value} (<= ${ceilingInv.max}) ${status}${age}`;
    }

    case 'RANGE': {
      const rangeInv = inv as RangeInvariant;
      const value = typeof m.value === 'number' ? m.value : '?';
      return `Latest measurement: ${value} (${rangeInv.min}-${rangeInv.max}) ${status}${age}`;
    }

    case 'BOOLEAN': {
      return `Latest measurement: ${m.passed ? 'PASSED' : 'FAILED'}${age}`;
    }

    default:
      return `Latest measurement: ${status}${age}`;
  }
}

/**
 * Render multiple invariants with measurements to a single prose block
 *
 * Uses the context's measurements array to match measurements to invariants.
 */
export function renderInvariantsWithMeasurements(
  invariants: Invariant[],
  context?: BlueprintContext
): string {
  if (invariants.length === 0) {
    return 'No invariants defined.';
  }

  // Build measurement lookup map
  const measurementMap = new Map<string, MeasurementInfo>();
  if (context?.measurements) {
    for (const m of context.measurements) {
      measurementMap.set(m.invariantId, m);
    }
  }

  // Group invariants by prefix
  const groups = groupByPrefix(invariants);

  const sections: string[] = [];

  for (const [prefix, group] of Object.entries(groups)) {
    const header = getPrefixHeader(prefix);
    const renderedInvariants = group
      .map((inv) => {
        const measurement = measurementMap.get(inv.id);
        return renderInvariantWithMeasurement(inv, measurement);
      })
      .join('\n\n');
    sections.push(`## ${header}\n\n${renderedInvariants}`);
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Render system invariants as prose with an introductory preamble explaining the system.
 */
export function renderSystemInstructionsAsProse(invariants: Invariant[]): string {
  const systemInvariants = invariants.filter((inv) => inv.id.startsWith('SYS-'));
  if (systemInvariants.length === 0) {
    return 'No system instructions available.';
  }

  // Preamble explaining the Blueprint and invariant system
  const preamble = `You are executing a job defined by a Blueprint. A Blueprint contains invariants - properties that must hold true when your work completes. Your job is to satisfy these invariants either by executing work directly or by delegating to child jobs.

Invariants are categorized by prefix. Common prefixes include (not exhaustive):
- GOAL-*: Outcomes this job must achieve
- STRAT-*: Strategic guidance on approach
- COORD-*: Coordination actions requiring immediate attention
- QUAL-*: Quality gates and verification requirements

The following are the system-level operating rules:`;

  const instructions = systemInvariants
    .map((inv) => {
      const statement = inv.type === 'BOOLEAN' ? inv.condition : renderConstraintStatement(inv);
      const assessment = inv.assessment ? `Verification: ${inv.assessment}` : '';
      return assessment ? `- ${statement}\n  ${assessment}` : `- ${statement}`;
    })
    .join('\n');

  return `${preamble}\n\n${instructions}`;
}

export function renderJobInvariantsWithMeasurements(
  invariants: Invariant[],
  context?: BlueprintContext
): string {
  const jobInvariants = invariants.filter((inv) => !inv.id.startsWith('SYS-'));
  if (jobInvariants.length === 0) {
    return 'No job-specific requirements available.';
  }

  const measurementMap = new Map<string, MeasurementInfo>();
  if (context?.measurements) {
    for (const m of context.measurements) {
      measurementMap.set(m.invariantId, m);
    }
  }

  const groups = groupByPrefix(jobInvariants);
  const sections: string[] = [];

  for (const [prefix, group] of Object.entries(groups)) {
    const header = getPrefixHeader(prefix);
    const renderedInvariants = group
      .map((inv) => {
        const measurement = measurementMap.get(inv.id);
        return renderInvariantWithMeasurement(inv, measurement);
      })
      .join('\n\n');
    sections.push(`## ${header}\n\n${renderedInvariants}`);
  }

  return sections.join('\n\n---\n\n');
}

export function renderContextAsProse(context?: BlueprintContext): string {
  if (!context) {
    return 'No context available.';
  }

  const sections: string[] = [];

  if (context.hierarchy) {
    const { totalJobs, completedJobs, activeJobs, children } = context.hierarchy;
    const header = `Hierarchy: ${completedJobs}/${totalJobs} completed, ${activeJobs} active`;
    const childLines = children.map((child) => {
      const name = child.jobName ? ` - ${child.jobName}` : '';
      const branch = child.branchName ? ` (branch: ${child.branchName})` : '';
      const summary = child.summary ? ` | ${child.summary}` : '';
      const status = child.status.toLowerCase();
      return `- ${child.requestId} ${status}${name}${branch}${summary}`;
    });
    sections.push([header, ...childLines].join('\n'));
  }

  if (context.progress) {
    const phases = context.progress.completedPhases?.length
      ? `Completed phases: ${context.progress.completedPhases.join(', ')}`
      : '';
    const summary = `Progress summary: ${context.progress.summary}`;
    sections.push([summary, phases].filter(Boolean).join('\n'));
  }

  if (context.artifacts && context.artifacts.length > 0) {
    const artifactLines = context.artifacts.map((artifact) => {
      const type = artifact.type ? ` (${artifact.type})` : '';
      return `- ${artifact.name}${type}: ${artifact.cid}`;
    });
    sections.push(['Artifacts:', ...artifactLines].join('\n'));
  }

  if (sections.length === 0) {
    return 'No context available.';
  }

  return sections.join('\n\n');
}

/**
 * Get measurement statistics for a set of invariants
 */
export function getMeasurementStats(
  invariants: Invariant[],
  context?: BlueprintContext
): { total: number; measured: number; passing: number; failing: number } {
  const measurementMap = new Map<string, MeasurementInfo>();
  if (context?.measurements) {
    for (const m of context.measurements) {
      measurementMap.set(m.invariantId, m);
    }
  }

  let measured = 0;
  let passing = 0;
  let failing = 0;

  for (const inv of invariants) {
    const measurement = measurementMap.get(inv.id);
    if (measurement) {
      measured++;
      if (measurement.passed) {
        passing++;
      } else {
        failing++;
      }
    }
  }

  return {
    total: invariants.length,
    measured,
    passing,
    failing,
  };
}
