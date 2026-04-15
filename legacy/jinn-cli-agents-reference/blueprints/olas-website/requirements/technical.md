# Technical Requirements

## TEC-001: Modern Static Site Architecture

**Assertion:**
The website is built as a statically generated site using a modern framework that enables fast builds, optimal performance, and developer productivity.

**Examples:**

| Do | Don't |
|---|---|
| Use Next.js with static export or similar framework (Astro, Gatsby) | Build a traditional server-rendered application |
| Generate HTML at build time for content pages | Rely on client-side rendering for core content |
| Use TypeScript for type safety and better developer experience | Use vanilla JavaScript without type checking |
| Implement component-based architecture for reusability | Write monolithic page templates with duplicated code |

**Commentary:**

Static site generation provides the best performance characteristics for an informational website: pre-rendered HTML, minimal JavaScript, edge deployment, and excellent SEO. Modern frameworks like Next.js combine static generation with dynamic capabilities where needed. TypeScript adds compile-time error checking and improves maintainability. Component architecture enables reuse and consistency across pages.

---

## TEC-002: Repository as Single Source of Truth

**Assertion:**
All website code, content, assets, and configuration reside in the GitHub repository at https://github.com/oaksprout/olas-website-1.

**Examples:**

| Do | Don't |
|---|---|
| Store content as Markdown files in the repository | Use external CMS that could become unavailable |
| Version control images and assets alongside code | Link to external asset hosts without local copies |
| Use GitHub Actions for all automation | Depend on external CI/CD services |
| Document configuration in repository README | Rely on undocumented environment variables or external configs |

**Commentary:**

The repository is the definitive source for everything related to the website. This approach provides: version history for all changes, ability to roll back or audit any modification, contributor workflow via pull requests, and no external dependencies for content management. Content in Markdown format is human-readable, easy to edit, and supports the full Git workflow. This aligns with the Open and Transparent constitutional principle.

---

## TEC-003: Performance Targets

**Assertion:**
The website meets quantified performance targets measured in production: <2s First Contentful Paint, <3s Largest Contentful Paint, Lighthouse Performance score >90.

**Examples:**

| Do | Don't |
|---|---|
| Monitor Core Web Vitals (LCP, FID, CLS) in production | Rely only on development environment performance |
| Set up performance budgets in build pipeline that fail on regression | Allow performance to degrade over time |
| Use performance monitoring (Vercel Analytics, Speedcurve) | Deploy without ongoing performance visibility |
| Optimize bundle size with tree-shaking and code splitting | Ship unnecessary dependencies in production bundles |

**Commentary:**

Performance targets translate the constitutional principle of Performance and Reliability into measurable criteria. Core Web Vitals are Google's standardized metrics that correlate with user experience. Continuous monitoring ensures performance doesn't regress with new features. Performance budgets in CI/CD catch regressions before deployment. These targets apply globally, not just for users with fast connections.

---

## TEC-004: Security Standards

**Assertion:**
The website implements security best practices including HTTPS, CSP headers, regular dependency updates, and protection against common web vulnerabilities.

**Examples:**

| Do | Don't |
|---|---|
| Enforce HTTPS with HSTS headers | Allow mixed content or HTTP fallback |
| Implement Content Security Policy headers | Leave CSP permissive or unimplemented |
| Automate dependency updates with Dependabot or Renovate | Manually check for updates sporadically |
| Sanitize any user-generated content | Trust user input without validation |
| Set secure cookie flags (HttpOnly, Secure, SameSite) | Use default cookie settings |

**Commentary:**

Security is essential even for static informational sites. HTTPS prevents man-in-the-middle attacks. Content Security Policy headers prevent XSS attacks by controlling which resources can load. Regular dependency updates patch known vulnerabilities. While the site has minimal attack surface compared to dynamic applications, following security best practices prevents common issues and sets the right foundation if dynamic features are added later.

---

## TEC-005: SEO and Discoverability

**Assertion:**
The website implements SEO best practices to maximize discoverability in search engines and social sharing.

**Examples:**

| Do | Don't |
|---|---|
| Generate semantic HTML with proper heading hierarchy (h1-h6) | Use divs with styling instead of semantic elements |
| Include meta descriptions, Open Graph tags, and Twitter Card markup | Omit social media preview metadata |
| Create a sitemap.xml and robots.txt | Leave search engine crawling to chance |
| Use descriptive URLs (`/docs/getting-started` not `/page?id=123`) | Generate cryptic or non-semantic URLs |
| Implement structured data (JSON-LD) for relevant content | Miss opportunities for rich search results |

**Commentary:**

Discoverability determines whether potential users can find the Olas website through search engines and social media. SEO is not manipulation - it's making content understandable to machines. Semantic HTML, descriptive URLs, and metadata help search engines index content accurately. Open Graph and Twitter Card tags control how links appear when shared. Structured data enables rich results in search engines. These practices are foundational and should be implemented from the start.

