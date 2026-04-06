---
title: Writing Invariants Guide
purpose: guide
scope: [gemini-agent, worker]
last_verified: 2026-01-30
related_code:
  - worker/prompt/providers/invariants/
  - gemini-agent/shared/ipfs-payload-builder.ts
  - blueprints/
keywords: [invariants, floor, ceiling, range, boolean, measurement, blueprint]
when_to_read: "When writing or modifying invariants for blueprints"
---

# Writing Invariants: A Comprehensive Guide

**Version**: 1.0
**Last Updated**: 2025-01-30

## Overview

Invariants are the core building blocks of Jinn blueprints. They define **what must be true** about your system, not how to achieve it. This guide teaches you how to write effective, measurable invariants using the four-type schema.

## The Four Invariant Types

The invariant system enforces measurability through a structured schema with four types:

### Type 1: FLOOR (Minimum Threshold)

**Purpose:** Define a minimum acceptable value or count.

**Structure:**
```json
{
  "id": "UNIQUE-ID",
  "type": "FLOOR",
  "metric": "metric_name",
  "min": 70,
  "assessment": "How to measure this metric"
}
```

**When to use:**
- Quality thresholds (e.g., "content must score at least 70/100")
- Minimum counts (e.g., "at least 3 sources cited")
- Performance floors (e.g., "response time under 200ms")
- Completion percentages (e.g., "test coverage at least 80%")

**Examples:**

```json
{
  "id": "QUAL-001",
  "type": "FLOOR",
  "metric": "content_quality",
  "min": 70,
  "assessment": "Rate 0-100: original insights, actionable value, mission alignment",
  "examples": {
    "do": [
      "Content with unique research or data analysis",
      "Actionable tutorials solving real problems"
    ],
    "dont": [
      "Regurgitated content from competitors",
      "Generic listicles without substance"
    ]
  }
}
```

```json
{
  "id": "GOAL-SOURCES",
  "type": "FLOOR",
  "metric": "sources_cited_per_claim",
  "min": 3,
  "assessment": "Count distinct data sources with URLs per quantitative claim"
}
```

**Rendered to agent:** "content_quality must be at least 70"

---

### Type 2: CEILING (Maximum Threshold)

**Purpose:** Define a maximum acceptable value or upper limit.

**Structure:**
```json
{
  "id": "UNIQUE-ID",
  "type": "CEILING",
  "metric": "metric_name",
  "max": 20,
  "assessment": "How to measure this metric"
}
```

**When to use:**
- Cost limits (e.g., "API costs must not exceed $20")
- Error thresholds (e.g., "error rate below 1%")
- Resource caps (e.g., "memory usage under 512MB")
- Time constraints (e.g., "build time under 5 minutes")

**Examples:**

```json
{
  "id": "SYS-COST",
  "type": "CEILING",
  "metric": "compute_cost_usd",
  "max": 20,
  "assessment": "Sum total API costs from telemetry logs"
}
```

```json
{
  "id": "GOAL-DISTRIBUTION",
  "type": "CEILING",
  "metric": "single_source_traffic_percent",
  "max": 80,
  "assessment": "Check analytics using blog_get_referrers to verify no single traffic source exceeds 80%",
  "examples": {
    "do": [
      "Diversified traffic: 40% organic, 30% social, 20% referral, 10% direct",
      "Multiple social platforms contributing"
    ],
    "dont": [
      "100% traffic from one Reddit post",
      "Over-dependence on a single distribution channel"
    ]
  }
}
```

**Rendered to agent:** "compute_cost_usd must be at most 20"

---

### Type 3: RANGE (Bounded Value)

**Purpose:** Define a value that must fall within a specific range.

**Structure:**
```json
{
  "id": "UNIQUE-ID",
  "type": "RANGE",
  "metric": "metric_name",
  "min": 3,
  "max": 7,
  "assessment": "How to measure this metric"
}
```

**When to use:**
- Frequency targets (e.g., "3-7 posts per week")
- Goldilocks zones (e.g., "team size between 5-10 people")
- Optimal ranges (e.g., "paragraph length 50-150 words")
- Balanced metrics (e.g., "technical depth 40-60% of content")

**Examples:**

```json
{
  "id": "GOAL-FREQUENCY",
  "type": "RANGE",
  "metric": "posts_per_week",
  "min": 3,
  "max": 7,
  "assessment": "Count posts published in the last 7 days",
  "examples": {
    "do": [
      "Consistent publishing schedule (e.g., Mon/Wed/Fri)",
      "Quality over quantity - 3 excellent posts beats 10 mediocre ones"
    ],
    "dont": [
      "Publishing 20 low-quality posts in one week",
      "Going 2 weeks without any posts"
    ]
  }
}
```

```json
{
  "id": "GOAL-DEPTH",
  "type": "RANGE",
  "metric": "technical_depth_percent",
  "min": 40,
  "max": 60,
  "assessment": "Calculate percentage of content that requires technical background to understand vs accessible content"
}
```

**Rendered to agent:** "posts_per_week must be between 3 and 7"

---

### Type 4: BOOLEAN (Condition)

**Purpose:** Define a true/false condition that must hold.

**Structure:**
```json
{
  "id": "UNIQUE-ID",
  "type": "BOOLEAN",
  "condition": "A clear statement of what must be true",
  "assessment": "How to verify this condition"
}
```

**When to use:**
- Process checks (e.g., "all tests pass")
- Existence validation (e.g., "README.md exists")
- State verification (e.g., "deployment is successful")
- Compliance checks (e.g., "code follows style guide")

**Examples:**

```json
{
  "id": "SYS-BUILD",
  "type": "BOOLEAN",
  "condition": "Build passes without errors",
  "assessment": "Run 'yarn build' and check exit code is 0"
}
```

```json
{
  "id": "GOAL-MISSION",
  "type": "BOOLEAN",
  "condition": "All content decisions must ladder up to the blog's mission: {{mission}}",
  "assessment": "Review each published post and verify it can be traced back to the stated mission",
  "examples": {
    "do": [
      "Ask 'Does this serve our mission?' before publishing",
      "Prioritize content that directly advances the mission"
    ],
    "dont": [
      "Publish content that dilutes focus",
      "Chase trends that don't align with mission"
    ]
  }
}
```

```json
{
  "id": "TECH-DOCS",
  "type": "BOOLEAN",
  "condition": "All public APIs have documentation with examples",
  "assessment": "Check that each exported function in src/ has JSDoc comments with @example tags"
}
```

**Rendered to agent:** "Build passes without errors"

---

## Writing Effective Assessments

The `assessment` field is **required** for all invariants. It defines **HOW** to measure or verify the invariant. This is what makes invariants actionable.

### Good Assessment Patterns

#### Specify What to Check
```json
"assessment": "Verify audit-report.md exists in the repository and contains security findings"
```

#### Specify Commands to Run
```json
"assessment": "Run 'yarn build' and check exit code is 0"
```

#### Specify Calculations
```json
"assessment": "Count posts published in the last 7 days"
```

#### Specify Data Sources
```json
"assessment": "Check analytics using blog_get_referrers to verify no single traffic source exceeds 80%"
```

#### Specify Rating Criteria
```json
"assessment": "Rate 0-100: original insights, actionable value, mission alignment"
```

### Bad Assessment Patterns

#### Too Vague
```json
"assessment": "Check quality"  // ❌ How? What defines quality?
```

#### Not Measurable
```json
"assessment": "Make sure it's good"  // ❌ What is "good"? How to measure?
```

#### No Method
```json
"assessment": "See if it works"  // ❌ How to see? What tools to use?
```

### Assessment Best Practices

1. **Be Specific:** Name exact files, commands, or tools to use
2. **Be Actionable:** Someone should be able to follow your assessment instructions
3. **Include Units:** Specify percentages, counts, scores with clear scales
4. **Reference Tools:** Mention specific functions or commands (e.g., "blog_get_stats")
5. **Define Scale:** For ratings, specify the scale (0-100, 1-5 stars, etc.)

---

## Choosing the Right Type

Use this decision tree:

```
Is it a yes/no condition?
├─ YES → BOOLEAN
└─ NO → Is it a numeric metric?
    ├─ YES → Does it have only a minimum?
    │   ├─ YES → FLOOR
    │   └─ NO → Does it have only a maximum?
    │       ├─ YES → CEILING
    │       └─ NO → Must be bounded → RANGE
    └─ NO → Rethink your invariant (all types require measurability)
```

### Examples by Use Case

| Use Case | Type | Example |
|----------|------|---------|
| "Build must pass" | BOOLEAN | `condition: "Build passes without errors"` |
| "At least 3 sources" | FLOOR | `metric: "sources_cited", min: 3` |
| "Cost under $20" | CEILING | `metric: "compute_cost_usd", max: 20` |
| "3-7 posts per week" | RANGE | `metric: "posts_per_week", min: 3, max: 7` |
| "README exists" | BOOLEAN | `condition: "README.md exists in repository root"` |
| "Test coverage > 80%" | FLOOR | `metric: "test_coverage_percent", min: 80` |
| "Response time < 200ms" | CEILING | `metric: "response_time_ms", max: 200` |
| "Team size 5-10 people" | RANGE | `metric: "team_member_count", min: 5, max: 10` |

---

## Variable Substitution

Use `{{variableName}}` handlebars syntax to reference values from the template's `inputSchema`:

```json
{
  "inputSchema": {
    "properties": {
      "blogName": { "type": "string" },
      "mission": { "type": "string" }
    }
  },
  "invariants": [
    {
      "id": "GOAL-001",
      "type": "BOOLEAN",
      "condition": "{{blogName}} exists to serve this mission: {{mission}}",
      "assessment": "Review published posts and verify alignment with stated mission"
    }
  ]
}
```

**Best Practices:**
- Use flat inputSchema properties (avoid nested objects)
- Provide sensible defaults for optional fields
- Use descriptive variable names

---

## Adding Examples (Optional)

You can optionally include `examples` with `do` and `dont` arrays to provide additional guidance:

```json
{
  "id": "GOAL-001",
  "type": "FLOOR",
  "metric": "content_quality",
  "min": 70,
  "assessment": "Rate 0-100: original insights, actionable value, mission alignment",
  "examples": {
    "do": [
      "Original research with unique data analysis",
      "Tutorials solving problems your audience actually has",
      "Case studies with measurable results"
    ],
    "dont": [
      "Regurgitated content from competitors",
      "Clickbait without substance",
      "Generic listicles without original perspective"
    ]
  }
}
```

**When to include examples:**
- Complex or subjective metrics that benefit from concrete examples
- Quality standards that need clarification
- Common mistakes you want to prevent

**When to skip examples:**
- Simple, self-explanatory invariants
- Purely technical checks (e.g., "build passes")
- When the assessment field is already very specific

---

## Common Patterns and Anti-Patterns

### Pattern: Quality Thresholds

```json
{
  "id": "QUAL-001",
  "type": "FLOOR",
  "metric": "content_originality_score",
  "min": 80,
  "assessment": "Rate 0-100 based on: unique research (40%), novel insights (30%), original examples (30%)"
}
```

### Pattern: Multi-Source Validation

```json
{
  "id": "RIGOR-001",
  "type": "FLOOR",
  "metric": "sources_per_claim",
  "min": 3,
  "assessment": "Count distinct independent sources with explicit URLs for each quantitative claim"
}
```

### Pattern: Resource Constraints

```json
{
  "id": "PERF-001",
  "type": "CEILING",
  "metric": "api_response_time_ms",
  "max": 200,
  "assessment": "Measure p95 response time from server logs over last 24 hours"
}
```

### Pattern: Balanced Metrics

```json
{
  "id": "BALANCE-001",
  "type": "RANGE",
  "metric": "new_vs_returning_visitor_ratio",
  "min": 30,
  "max": 70,
  "assessment": "Calculate percentage of new visitors from analytics (should be between 30-70%)"
}
```

### Anti-Pattern: Vague Conditions

```json
// ❌ BAD
{
  "type": "BOOLEAN",
  "condition": "Content should be high quality",
  "assessment": "Check if it's good"
}

// ✅ GOOD
{
  "type": "FLOOR",
  "metric": "content_quality_score",
  "min": 80,
  "assessment": "Rate 0-100: originality (40%), depth (30%), actionability (30%)"
}
```

### Anti-Pattern: Unmeasurable Requirements

```json
// ❌ BAD
{
  "type": "BOOLEAN",
  "condition": "Code is maintainable",
  "assessment": "See if future developers can understand it"
}

// ✅ GOOD
{
  "type": "FLOOR",
  "metric": "code_documentation_coverage",
  "min": 90,
  "assessment": "Count percentage of functions with JSDoc comments"
}
```

### Anti-Pattern: Process-Focused Instead of Outcome-Focused

```json
// ❌ BAD
{
  "type": "BOOLEAN",
  "condition": "Use google_web_search tool to research topics",
  "assessment": "Verify google_web_search was called"
}

// ✅ GOOD
{
  "type": "FLOOR",
  "metric": "authoritative_sources_cited",
  "min": 3,
  "assessment": "Count distinct authoritative sources with timestamps and URLs"
}
```

---

## Complete Example: Blog Template

Here's a complete example showing all four types in context:

```json
{
  "templateMeta": {
    "id": "blog-growth",
    "name": "Blog Growth Template",
    "inputSchema": {
      "properties": {
        "blogName": { "type": "string" },
        "mission": { "type": "string" }
      }
    },
    "tools": [
      { "name": "blog_create_post", "required": true },
      { "name": "blog_list_posts", "required": true },
      { "name": "blog_get_stats", "required": true },
      { "name": "process_branch", "required": true },
      { "name": "write_file" }
    ]
  },
  "invariants": [
    {
      "id": "GOAL-MISSION",
      "type": "BOOLEAN",
      "condition": "{{blogName}} exists to serve this mission: {{mission}}. All content decisions must ladder up to this purpose.",
      "assessment": "Review each published post and verify it can be traced back to the stated mission",
      "examples": {
        "do": [
          "Ask 'Does this serve our mission?' before publishing",
          "Prioritize content that directly advances the mission"
        ],
        "dont": [
          "Publish content that dilutes focus",
          "Chase trends that don't align with mission"
        ]
      }
    },
    {
      "id": "GOAL-QUALITY",
      "type": "FLOOR",
      "metric": "content_quality_score",
      "min": 70,
      "assessment": "Rate 0-100: original insights (40%), actionable value (30%), mission alignment (30%)"
    },
    {
      "id": "GOAL-DISTRIBUTION",
      "type": "CEILING",
      "metric": "single_source_traffic_percent",
      "max": 80,
      "assessment": "Check analytics using blog_get_referrers to verify no single traffic source exceeds 80%"
    },
    {
      "id": "GOAL-FREQUENCY",
      "type": "RANGE",
      "metric": "posts_per_week",
      "min": 2,
      "max": 5,
      "assessment": "Count posts published in the last 7 days"
    }
  ]
}
```

---

## Checklist for Writing Invariants

Before finalizing an invariant, verify:

### Required Fields
- [ ] `id` is unique and follows convention (e.g., `GOAL-001`, `SYS-001`)
- [ ] `type` is one of: FLOOR, CEILING, RANGE, BOOLEAN
- [ ] Type-specific fields present:
  - FLOOR: `metric`, `min`
  - CEILING: `metric`, `max`
  - RANGE: `metric`, `min`, `max`
  - BOOLEAN: `condition`
- [ ] `assessment` explains HOW to measure/verify

### Quality Checks
- [ ] Assessment is specific and actionable
- [ ] Assessment includes method (command, tool, or process)
- [ ] Metric names are clear and descriptive
- [ ] Numbers have context (units, scale, range)
- [ ] Examples (if included) are concrete and helpful

### Measurability
- [ ] Someone could follow the assessment instructions
- [ ] Success/failure can be objectively determined
- [ ] No subjective terms without defined criteria

### Style
- [ ] Uses outcome language, not process language
- [ ] No tool prescriptions (unless absolutely necessary)
- [ ] No implementation details (unless required for verification)
- [ ] Variable substitution uses `{{variableName}}` format

---

## Voice Guidelines

When writing invariants, use the correct voice pattern to maximize LLM effectiveness. This follows [Anthropic's prompt engineering best practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering).

### Use Second-Person ("You") for Conditions

Conditions describe what the agent must do. Use "You" voice for direct instruction.

**Good:**
```json
{
  "condition": "You operate autonomously without user interaction",
  "condition": "You must verify all data before proceeding",
  "condition": "You dispatch children when work can be parallelized"
}
```

**Bad:**
```json
{
  "condition": "Agent operates autonomously",     // Third-person creates distance
  "condition": "I operate autonomously",          // First-person is less standard
  "condition": "The system should operate autonomously"  // Passive/indirect
}
```

### Use Imperative for Assessments

Assessments describe how to verify. Use command form (imperative voice).

**Good:**
```json
{
  "assessment": "Verify that decisions are made independently",
  "assessment": "Check exit code is 0 after running build",
  "assessment": "Confirm all tests pass before marking complete"
}
```

**Bad:**
```json
{
  "assessment": "The agent should verify...",    // Indirect
  "assessment": "We need to check...",           // First-person plural
  "assessment": "It should be verified that..."  // Passive
}
```

### Avoid Negative Instructions

Research shows negative instructions can backfire by drawing attention to unwanted behavior. Prefer positive alternatives.

**Good:**
```json
{
  "condition": "You operate only on verified information"
}
```

**Bad:**
```json
{
  "condition": "Don't hallucinate or make up data"  // Draws attention to hallucination
}
```

### Quick Reference

| Pattern | Good | Bad |
|---------|------|-----|
| Conditions | "You must verify data" | "Agent must verify data" |
| Assessments | "Verify that..." | "The agent should verify..." |
| Negative | "You use verified sources" | "Don't make things up" |
| Children | "You dispatch children when..." | "I will dispatch children..." |

---

## Summary

**The Four Types:**
1. **FLOOR** - minimum threshold (at least X)
2. **CEILING** - maximum threshold (at most X)
3. **RANGE** - bounded value (between X and Y)
4. **BOOLEAN** - yes/no condition (must be true)

**The Golden Rules:**
1. Every invariant MUST have an `assessment` field
2. Assessment must explain HOW to measure
3. Choose the type that matches your requirement's structure
4. Be specific, measurable, and actionable
5. Focus on outcomes, not processes

**Quick Reference:**

| If you need to... | Use type... | With fields... |
|-------------------|-------------|----------------|
| Set a minimum | FLOOR | `metric`, `min` |
| Set a maximum | CEILING | `metric`, `max` |
| Set a range | RANGE | `metric`, `min`, `max` |
| Check a condition | BOOLEAN | `condition` |

Remember: Invariants define **what must be true**, not **how to make it true**. The system decides the "how" - you define the "what" and provide the measurement method.
