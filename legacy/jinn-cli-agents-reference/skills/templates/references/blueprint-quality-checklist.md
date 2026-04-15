# Blueprint Quality Checklist

Pre-flight checklist before entering the testing pipeline.

---

## File Structure

- [ ] Blueprint lives at `blueprints/<slug>.json`
- [ ] Has `templateMeta` section with `id`, `name`, `description`, `inputSchema`, `outputSpec`, `tools`
- [ ] Has `invariants` array at top level
- [ ] Test input lives at `blueprints/inputs/<slug>-test.json`
- [ ] Test input has all `required` fields from `inputSchema`

## Input / Output Contract

- [ ] `inputSchema` has all required fields with descriptions
- [ ] `outputSpec` fields match what invariants promise to produce
- [ ] Field types are correct (`string` for text, `number` for counts, `array` for lists)
- [ ] Required fields are truly required — optional fields marked accordingly
- [ ] Every `outputSpec` field has a matching instruction in at least one invariant

## Invariant Quality

- [ ] Each invariant has `id`, `type`, `condition`, `assessment`, and `examples`
- [ ] Outcomes over implementation — describe WHAT, not HOW
- [ ] Each invariant is independently verifiable
- [ ] `examples.do` has >=3 concrete examples
- [ ] `examples.dont` has >=2 anti-patterns
- [ ] No conflicting invariants

## Variable Substitution

- [ ] `{{placeholders}}` in invariants match `inputSchema` property names
- [ ] `{{currentTimestamp}}` used if the template needs time awareness
- [ ] No hardcoded values that should be input parameters

## Tool Policy

- [ ] Tools list includes everything the agent will need
- [ ] `required: true` on tools the agent must call (e.g., `create_artifact`)
- [ ] No references to tools that have been removed (e.g., Telegram tools in a data-only template)

## Infrastructure Test Templates

Only for test harness blueprints that require deterministic single-execution (e.g., `nano-banana-test`, `browser-automation-test`):

- [ ] Anti-delegation language added if and only if single-execution is required for test validation
- [ ] Scope is achievable within the marketplace response timeout (configurable per-request, queried on-chain)
- [ ] Pagination guidance included for tools that return paginated results

**Note:** Production templates should NOT override delegation. Fan-out is a core protocol feature.

## Pricing

- [ ] `priceWei` set appropriately (`"0"` for internal/free templates)
