# Content Requirements

## CON-001: Multi-Persona Information Architecture

**Assertion:**
The website information architecture accommodates distinct user personas with dedicated navigation paths and content entry points.

**Examples:**

| Do | Don't |
|---|---|
| Create dedicated landing pages for Developers, Operators, and Researchers | Force all users through a single homepage narrative |
| Use persona-specific language in navigation ("Build" for devs, "Run" for operators) | Use generic labels that don't speak to specific needs |
| Provide quick-start guides tailored to each persona's workflow | Offer only comprehensive documentation without filtering |

**Commentary:**

The Olas ecosystem serves multiple distinct audiences with different goals and technical backgrounds. Developers need API references and integration guides. Operators need deployment instructions and operational best practices. Researchers need whitepapers and protocol specifications. The information architecture must provide clear entry points and navigation paths for each persona while allowing cross-pollination where interests overlap.

---

## CON-002: Progressive Disclosure

**Assertion:**
Content is organized to reveal complexity progressively, starting with high-level concepts and allowing users to drill down into technical details as needed.

**Examples:**

| Do | Don't |
|---|---|
| Start explanations with "what" and "why" before diving into "how" | Lead with technical implementation details |
| Use expandable sections for advanced topics within foundational content | Mix beginner and advanced content at the same hierarchy level |
| Provide "Learn More" links to deeper resources without breaking the main narrative | Require users to read everything to understand basics |

**Commentary:**

Not everyone arrives at the website with the same background knowledge. Progressive disclosure allows newcomers to grasp core concepts quickly while providing pathways for experienced users to access technical depth. This pattern respects diverse learning styles and time constraints, making the website effective for both quick orientation and deep research.

---

## CON-003: Technical Accuracy Verification

**Assertion:**
All technical content undergoes verification against source code, official documentation, and deployed contracts before publication.

**Examples:**

| Do | Don't |
|---|---|
| Link to specific GitHub commits or contract addresses for technical claims | Make claims about protocol behavior without source references |
| Include code examples that are tested and runnable | Copy code snippets without verifying they compile/execute |
| Update content when protocol upgrades change documented behavior | Let content drift out of sync with actual implementation |

**Commentary:**

Technical inaccuracy damages credibility and can lead users to implement integrations incorrectly. The verification process must include: 1) Cross-referencing claims against source code, 2) Testing code examples in actual development environments, 3) Reviewing content with core protocol developers. This requirement is non-negotiable - accuracy is the foundation of the website's authority.

---

## CON-004: Content Freshness

**Assertion:**
Content reflects the current state of the Olas protocol and ecosystem, with mechanisms to flag or update outdated information.

**Examples:**

| Do | Don't |
|---|---|
| Display last-updated timestamps on documentation pages | Publish undated content that could become stale |
| Implement automated checks for broken links and deprecated APIs | Allow dead links and obsolete references to accumulate |
| Maintain a content calendar for reviewing high-traffic pages | Let popular pages go unreviewed for extended periods |

**Commentary:**

Blockchain protocols evolve rapidly through upgrades, new features, and ecosystem growth. Outdated content misleads users and creates support burden. The freshness requirement demands both reactive updates (when protocol changes) and proactive reviews (scheduled audits of content accuracy). Timestamps and version indicators help users assess whether information applies to their use case.

---

## CON-005: Educational Progression

**Assertion:**
Learning content follows a structured progression from fundamentals to advanced topics, with clear prerequisites and learning paths.

**Examples:**

| Do | Don't |
|---|---|
| Organize tutorials as "101", "201", "301" sequences with stated prerequisites | Scatter tutorials without indicating difficulty or dependencies |
| Provide a visual learning path diagram showing content relationships | Expect users to figure out the optimal reading order themselves |
| Include "What you'll learn" and "Prerequisites" sections in educational content | Dive into tutorials without setting expectations |

**Commentary:**

Effective education requires scaffolding - building new knowledge on established foundations. The learning path structure helps users self-assess their starting point and chart a course to their goals. This is particularly important for Olas, where understanding autonomous services requires knowledge of smart contracts, agent frameworks, and economic mechanisms. Clear progression reduces frustration and increases successful onboarding.

