# Colophon design QA

Status: **PASS**

Date: 2026-08-10  
Reference: user-supplied `Colophon Design System.zip`, SHA-256 `1e01ec1ef9f2db4b2862996fe401231785e98801d96706c679c67e1bb4330a50`

## Compared views

Each implementation capture was reviewed beside the matching reference state, not in isolation.

| Surface | Reference | Implementation | Result |
| --- | --- | --- | --- |
| Public site, desktop | `reference-captures/site-desktop-1280.png` | `qa-captures/site-desktop-1280.png` | Pass |
| Public site, mobile | `reference-captures/site-mobile-390.png` | `qa-captures/site-mobile-390.png` | Pass |
| Workspace, desktop | `reference-captures/app-desktop-1280.png` | `qa-captures/workspace-desktop-1280.png` | Pass |
| Public report, desktop | `reference-captures/report-desktop-1000.png` | `qa-captures/report-desktop-1280.png` | Pass |
| Public report, mobile | `reference-captures/report-mobile-390.png` | `qa-captures/report-mobile-390.png` | Pass |
| Future pricing preview, mobile | Design-system vocabulary | `qa-captures/pricing-preview-mobile-390.png` | Pass |

## Visual fidelity

- The warm paper, ink, vermilion, muted-rule, and dark-code colors are sourced from one Colophon token layer.
- Newsreader, Public Sans, and IBM Plex Mono are locally packaged. No remote font or image request is required.
- The real source mark and lockup are used byte-for-byte; no CSS or text approximation was introduced.
- The public site preserves the reference's editorial scale, generous vertical rhythm, hairline rules, square geometry, and absence of decorative shadows.
- The workspace adapts the reference's compact product shell, ledger-like side navigation, lifecycle markers, and restrained controls without changing the existing operation flow.
- The static report uses the same visual grammar offline, with embedded fonts and source mark, semantic tables, compact detached assets, print rules, and local record links.
- Desktop and 390-pixel captures have no document-width overflow. The reference's mobile overflow was intentionally corrected rather than copied.

## Product-truth adaptations

The visual system was adopted without importing unsupported product claims:

- The implementation never selects a winner or turns a point estimate into a comparative conclusion.
- Matrix, Report, and stored Claim facts remain independently labelled where their values could disagree.
- Real setup, launch, cancellation, collection, report, verification, and publication states replace the reference's illustrative result model.
- Reports, task sets, entrants, evaluators, runs, agents, billing, docs, and pricing remain visible as read-only future-service previews. Each preview says it is illustrative, unavailable today, and does not expose a fake transaction or deployment path.
- “Built on Jinn” remains attribution; Colophon is the product identity and preferred command name.

## Responsive, accessibility, and security checks

- Public site: 1280-pixel desktop and 390 × 844 mobile reviewed.
- Workspace: 1280-pixel desktop reviewed; existing production Playwright coverage continues to exercise 390-pixel lifecycle states.
- Public report: 1280-pixel desktop and 390 × 844 mobile reviewed after source-workspace deletion.
- Preview: pricing reviewed at 390 × 844; it contains no form, checkout, amount, or enabled hosted-service action.
- Semantic landmarks, a single page heading, keyboard focus indicators, labelled horizontal table regions, reduced-motion behavior, print styling, and hostile-content wrapping are retained.
- Browser console review returned zero warnings and zero errors for the final public site and public report.
- Final views contain no remote asset URLs. The portable report remains a fixed, verifier-rederived five-asset bundle.

## Deliberate differences from the reference

- Reference copy suggesting rankings or causal conclusions was replaced with neutral, registered-method facts.
- Reference SaaS screens are represented as clearly labelled previews until the hosted service exists.
- The existing full lifecycle and error vocabulary remains visible rather than being flattened into a mock dashboard.
- Mobile containment, offline provenance, exact source-labelled facts, and accessible report semantics are stronger than the supplied reference.

No blocking visual, responsive, accessibility, security, or product-truth mismatch remains.
