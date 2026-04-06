# Operations Requirements

## OPS-001: Automated CI/CD Pipeline

**Assertion:**
All changes to the repository trigger automated testing, building, and deployment through a CI/CD pipeline that enforces quality gates.

**Examples:**

| Do | Don't |
|---|---|
| Use GitHub Actions to build, test, and deploy on every push | Manually deploy changes without automation |
| Run linting, type checking, and tests in CI before allowing merge | Deploy code without automated quality checks |
| Deploy to preview environments for pull requests | Require manual environment setup to review changes |
| Automate production deployment on merge to main branch | Require manual deployment steps for production |

**Commentary:**

Automated CI/CD reduces human error, speeds up development cycles, and ensures consistent quality. The pipeline should include: linting and formatting checks, TypeScript compilation, automated tests, build verification, performance budget checks, and accessibility testing. Preview deployments for pull requests enable reviewers to see changes in a live environment. Production deployment automation ensures every merge to main is quickly reflected on the live site.

---

## OPS-002: Content Update Workflow

**Assertion:**
Content updates follow a defined workflow: create branch, edit Markdown files, preview changes, submit pull request, review, merge, and auto-deploy.

**Examples:**

| Do | Don't |
|---|---|
| Provide documentation for non-technical contributors to submit content changes | Require contributors to understand build system to update content |
| Use pull request templates that prompt for content review checklist | Accept content changes without review process |
| Enable preview deployments showing rendered content before merge | Require contributors to build locally to see changes |
| Maintain content style guide in repository | Let content quality and consistency drift |

**Commentary:**

Content is maintained in Markdown files in the repository, enabling the full Git workflow. The process must be accessible to non-technical contributors while maintaining quality standards. Pull request templates guide contributors through necessary checks (accuracy, links, formatting). Preview deployments are critical - they show the rendered result without requiring local development setup. The workflow balances ease of contribution with quality control.

---

## OPS-003: Monitoring and Analytics

**Assertion:**
The website implements privacy-respecting analytics and uptime monitoring to track usage patterns, identify issues, and inform improvements.

**Examples:**

| Do | Don't |
|---|---|
| Use privacy-focused analytics (Plausible, Fathom) without cookies | Implement invasive tracking that requires cookie banners |
| Monitor uptime and performance from multiple global locations | Rely on manual checks or single-point monitoring |
| Track page views, referrers, and user journeys without PII | Collect personally identifiable information unnecessarily |
| Set up alerts for downtime or performance degradation | Discover issues only when users report them |

**Commentary:**

Analytics inform decisions about content priorities, navigation improvements, and technical optimizations. Privacy-respecting analytics tools provide useful data without compromising user privacy or requiring cookie consent banners. Uptime monitoring detects hosting issues quickly. Performance monitoring (Core Web Vitals) in production validates that optimization efforts translate to real-world improvements. Error tracking helps identify and fix broken functionality.

---

## OPS-004: Community Contribution Process

**Assertion:**
The repository documentation clearly explains how community members can contribute code, content, or design improvements, with a defined review and merge process.

**Examples:**

| Do | Don't |
|---|---|
| Maintain CONTRIBUTING.md with setup instructions and guidelines | Leave contributors guessing how to get started |
| Use issue templates for bug reports and feature requests | Accept freeform issues without structured information |
| Respond to pull requests within 48 hours with feedback | Let contributions sit without acknowledgment |
| Recognize contributors in release notes or a dedicated page | Take contributions without attribution |

**Commentary:**

Open contribution aligns with the Open and Transparent constitutional principle. The CONTRIBUTING.md file should cover: local development setup, code style requirements, testing procedures, commit message format, and pull request guidelines. Issue templates reduce back-and-forth by collecting necessary information upfront. Timely review and feedback respect contributors' time. Recognition encourages continued participation. This process scales community involvement while maintaining quality.

---

## OPS-005: Disaster Recovery

**Assertion:**
The website can be fully restored from the Git repository within 1 hour in the event of hosting failure or data loss.

**Examples:**

| Do | Don't |
|---|---|
| Document deployment procedure in repository README | Rely on undocumented manual steps |
| Use infrastructure-as-code for hosting configuration | Configure hosting through UI without version control |
| Test recovery procedure quarterly | Assume recovery works without testing |
| Maintain backups of any dynamic data (analytics, form submissions) | Lose data that's not in Git |

**Commentary:**

Disaster recovery ensures business continuity. With the repository as the single source of truth, recovery primarily means redeploying from Git. Infrastructure-as-code (Terraform, CloudFormation, or provider-specific configs) ensures hosting can be recreated identically. Documentation must be clear enough that someone unfamiliar with the system could perform recovery. Regular testing validates the procedure works and keeps documentation current. The 1-hour target reflects the site's importance while being achievable with static site architecture.

