---
name: jinn-design
description: Use this skill to generate well-branded interfaces and assets for Jinn, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the `README.md` file within this skill, and explore the other available files (`colors_and_type.css`, `foundations.css`, `assets/`, `ui_kits/`, `slides/`).

Jinn is a **headless, co-created brand** — the system is a starting point, not a law. Keep the vocabulary (summon, bind, vow, vessel, wish, smoke, seer, wane); the visuals are allowed to shift. When in doubt: keep the words, loosen the visuals.

Visually, Jinn is **protocol brutalism**: dark-first, square corners, hairline borders, mono type (JetBrains Mono), with Instrument Serif reserved for display headlines and italic pull-quotes. No sans. No emoji. No gradients as decoration. No soft shadows except on floating overlays. Hover states brighten or strengthen borders; they do not lift or glow.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out of `assets/` and pull `colors_and_type.css` + `foundations.css` into a static HTML file for the user to view. If working on production code, copy assets and read the rules in `README.md` to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions (audience, surface, fidelity, whether they want to stay "canonical Jinn" or explore the headless edges), and act as an expert designer who outputs HTML artifacts or production code, depending on the need.

**Non-negotiables:**
- Never use emoji.
- Never use gradients as decoration.
- Never use rounded corners on cards/panels/buttons (square is the rule; chips + pills are the two exceptions).
- Never invent new vow-language without marking it as a proposal.
- Plain, clear speech beats poetic speech whenever money, safety, or legal consent is on the line.
