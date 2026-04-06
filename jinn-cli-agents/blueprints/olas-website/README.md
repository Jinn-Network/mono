# Olas Website Blueprint

This blueprint defines the foundation for the official Olas informational website at https://github.com/oaksprout/olas-website-1.

## What is a Blueprint?

A blueprint is the complete specification for an autonomous venture. It defines:
- **What** the venture should achieve (vision, objectives)
- **Why** it exists (mission, principles)
- **How** it should operate (requirements, constraints)

The blueprint serves as the source of truth that agents continuously verify against and work to fulfill.

## Structure

### Intent Documents (Human-Defined)

- **[index.md](./index.md)**: Overview and navigation
- **[constitution.md](./constitution.md)**: Core immutable principles
  - Accuracy and Authority
  - Community-Centric Design
  - Open and Transparent
  - Performance and Reliability
- **[vision.md](./vision.md)**: Mission and strategic vision

### Requirements (Human-Defined, Agent-Verified)

Located in `requirements/`:

- **[content.md](./requirements/content.md)** (CON-001 through CON-005)
  - Multi-persona information architecture
  - Progressive disclosure
  - Technical accuracy verification
  - Content freshness
  - Educational progression

- **[ux-design.md](./requirements/ux-design.md)** (UXD-001 through UXD-005)
  - WCAG 2.1 AA accessibility
  - Mobile-first responsive design
  - Olas brand alignment
  - Intuitive navigation
  - Performance budgets

- **[technical.md](./requirements/technical.md)** (TEC-001 through TEC-005)
  - Modern static site architecture
  - Repository as single source of truth
  - Performance targets
  - Security standards
  - SEO and discoverability

- **[operations.md](./requirements/operations.md)** (OPS-001 through OPS-005)
  - Automated CI/CD pipeline
  - Content update workflow
  - Monitoring and analytics
  - Community contribution process
  - Disaster recovery

## How It Works

1. **Root Job**: A canonical root job (`dispatch-olas-website.ts`) is responsible for ensuring the repository fulfills all blueprint assertions.

2. **Continuous Verification**: The root job regularly audits the repository state against the blueprint requirements.

3. **Self-Correction**: When violations or gaps are detected, the root job dispatches child jobs to bring the implementation into alignment.

4. **Transparency**: Progress is tracked via `launcher_briefing` artifacts created on each run.

## Using This Blueprint

### For Humans

- Read the constitution to understand core principles
- Review requirements to see what's expected
- Check launcher_briefing artifacts to see current status
- Propose changes via pull requests to the blueprint itself

### For Agents

The root job automatically:
- Reads and parses the blueprint structure
- Verifies current implementation state
- Identifies violations or unmet requirements
- Dispatches targeted jobs to address gaps
- Tracks progress and reports status

Each requirement follows a three-part structure:
```markdown
## REQ-ID: Requirement Title

**Assertion:**
[Clear, verifiable statement]

**Examples:**

| Do | Don't |
|---|---|
| [Positive example] | [Negative example] |

**Commentary:**
[Context and rationale]
```

## Repository

Implementation: **https://github.com/oaksprout/olas-website-1**

## Dispatching the Venture

```bash
yarn tsx scripts/dispatchers/dispatch-olas-website.ts
```

This creates the root job that will bootstrap and maintain the website in accordance with this blueprint.

## Blueprint as IPFS Directory

This blueprint is designed to be publishable as a directory on IPFS, making it permanently accessible and content-addressed. The structured markdown format ensures it's both human-readable and agent-parseable.

