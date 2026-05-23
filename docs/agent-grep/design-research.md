# Design Research

GREP_HANDLES: AGENT_DOC DESIGN_RESEARCH DESIGN_RESOURCE_SEARCH FRONTEND_DESIGN DOCUMENT_DESIGN VISUAL_QA UI_CHECK

Use when:
- Building or improving a website, app UI, dashboard, generated HTML, PDF-oriented HTML, deck, or document.
- The task needs visual direction, imagery, icons, fonts, layout examples, or accessibility checks.
- The result will be user-facing and should not feel generic.

Primary tools:
- `design-resource-search`: curated safe source lookup for fonts, icons, images, CSS, and design references.
- `web-search`: broader public research when current examples or competitors matter.
- `web-fetch`: verify selected pages before relying on them.
- `web-scrape`: JS-rendered pages, structured extraction, or screenshot capture.
- `image-generate`: custom bitmap visuals when no existing asset fits.
- `graph-diagram`: SVG/diagram assets for reports, docs, and dashboards.
- `code-sandbox`: runnable static preview bundles.

Quick flow:
1. Define surface: website, dashboard, document, presentation, canvas, or sandbox preview.
2. Call or grep `design-resource-search` for approved fonts, icons, images, and CSS references.
3. Fetch 1 to 3 selected sources with `web-fetch`; use `web-scrape` only when rendering or extraction is needed.
4. Pick explicit design tokens: `--text`, `--muted`, `--surface`, `--panel`, `--accent`, `--border`.
5. Build real content and real assets. Avoid placeholder-heavy design.
6. Verify with `node bin/kimibuilt-ui-check.js <url-or-file-url> --out ui-checks/<name>` when browser QA is available.

Design guardrails:
- No white text on pale backgrounds or dark text on dark backgrounds.
- Text over images needs a solid or strongly translucent overlay with explicit foreground and background colors.
- Avoid one-note palettes and giant marketing heroes for operational tools.
- Use charts, icons, diagrams, and images as real information, not decoration.
- For print/PDF, declare `@page` geometry and use print-safe contrast.

Good grep targets:
- `src/agent-sdk/tool-docs/design-resource-search.md`
- `src/design-resource-index.js`
- `data/skills/impressive-frontend-websites/SKILL.md`
- `bin/kimibuilt-ui-check.js`
- `agents.md` section: Generated HTML and Document Design Guardrails
