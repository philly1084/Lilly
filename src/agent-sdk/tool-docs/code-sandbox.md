# code-sandbox

Purpose: execute code in an isolated Docker container, or persist previewable frontend project files.

Requirements:
- Docker engine access from the backend runtime
- language image pull/run capability
- For `mode: "project"`, an active session is recommended so the tool can save a previewable artifact.

Use when:
- the user explicitly asks to run code
- a contained execution result is needed
- the user asks for a local HTML/Vite-style frontend creation that should be previewed or downloaded from the CLI

Notes:
- `mode: "execute"` is operationally heavier than analysis-only tools and requires Docker.
- `mode: "project"` writes files under `output/sandboxes`, returns authenticated workspace preview URLs, and packages them as a frontend bundle artifact when persistence is available.
- Execution languages include JavaScript, Python, Java, Bash, Ruby, Go, and Rust. `dependencies` are installed before execution for JavaScript with npm and Python with pip; set `network: true` when packages must be downloaded.
- Java execution expects a `public class Main` entry point because sandbox code is saved as `Main.java`.
- Previewable site, app, and game projects should use `mode: "project"` with `language: "html"`, `"vite"`, `"react"`, or `"tailwind"`. Use `"vite"` for multi-file apps, browser games, simulations, and any request that expects a Vite-style preview/handoff.
- Do not use `mode: "execute"` for website or document previews when `mode: "project"` can persist a previewable bundle.
- Direct `code-sandbox` project calls must include complete `files` or non-empty `code`. A `prompt` by itself is not a playable sandbox input; use `document-workflow generate-suite` with `buildMode:"sandbox"` / `useSandbox:true` when the runtime needs to generate React/Vite files from an idea.
- Project previews are static browser previews with Vite-style file handoff, so generated sites should prefer browser imports that run directly in the iframe. Good defaults: React + ReactDOM via ESM CDN or UMD scripts, Tailwind via the browser CDN script, graph/data visualization through the local sandbox library routes below or matching CDN fallbacks, and code/document viewing through CodeMirror, highlight.js, Marked, PDF.js, Mammoth, or docx.js when the task involves source, docs, PDF, or Word-style content. Include `package.json`, `vite.config.js`, and `src/` files for repo handoff when useful, but the preview entry must still run without npm install.
- Use the sandbox technology ladder: static HTML only for simple read-only pages; React/Vite for app-like, dashboard, editor, portal, multi-step, or stateful UI; Three.js/WebGL for spatial, immersive, 3D, or product-configurator experiences; Matter.js/p5.js/GSAP for games, physics, motion, and sketches; Chart.js/D3/ECharts/Plotly/Cytoscape/force-graph for data-heavy experiences; CodeMirror/highlight.js/Marked/PDF.js/Mammoth for code and document viewer sandboxes.
- Non-trivial frontend bundles should include `AGENT_SANDBOX_BUILD.md` with the local build brief, technology choice, important files, local QA checks, remaining assumptions, and remote/live promotion notes.
- For local-to-live work, keep the sandbox as Stage 1, run visual/browser QA as Stage 2, then pass the bundle/artifact IDs, source files, technology choice, and QA notes into `managed-app iterate` or `remote-cli-agent` as Stage 3. Stage 4 is live only after Git/source evidence, build or image evidence, rollout/deploy evidence, public URL, and browser/UI-check proof exist.
- For website, dashboard, landing-page, app workspace, frontend demo, HTML prototype, or UI mockup work, apply the Impressive Frontend Websites standard: infer a compact brief, build the actual usable first screen, use relevant visual assets, include real controls/states/interactions, verify desktop/mobile and opened UI states, then refine after the first render for non-trivial builds.
- For browser games, playable simulations, and multi-step Vite apps, apply the Sandbox Vite Games standard: create separate project files, build a real game loop or workflow state machine, include visible controls/HUD/status, support pause/restart/reset, handle keyboard plus pointer/touch input when relevant, verify nonblank canvas/WebGL rendering, and run a repair pass after the first preview.
- The first viewport should identify the product, place, workflow, offer, or audience immediately. Avoid generic hero/templates, one-note palettes, decorative blobs, nested cards, clipped labels, horizontal overflow, broken assets, and unreadable dropdown/menu/popover/dialog/tooltip states.
- For document previews, treat sandbox output as an editable visual source, not the final DOCX/PDF unless the user asked for HTML. Include print CSS, explicit page margins, stable section IDs, relative asset paths, and readable table/figure/callout styles.
- For code/document viewer sandboxes, include real reading and editing affordances instead of static text dumps: file tree or tabs, line numbers, syntax highlighting, rendered Markdown, outline/search, copy/download actions, import/drop states, and clear loading/empty/error states.
- For sandboxed document builds, follow the Kimi K2.6-style creation loop: lock the user intent, list known context and safe assumptions, choose the structure and export path, build the source, render or inspect it, repair visible issues, then hand off proof.
- Include an alignment snapshot in `AGENT_SANDBOX_BUILD.md` or the final response: user goal, audience, target format, assumptions, open questions, acceptance checks, checks run, and checks still needed before export or user approval.
- Do not fake office formats in the sandbox. If the requested deliverable is DOCX, PDF, or PPTX, use sandbox HTML to preview only, then hand the source to the document/export path and verify the rendered artifact.
- For PDF-oriented HTML, define `@page` size and margins, avoid viewport-height hero sections, set dark-on-light print defaults, and check for awkward page breaks around headings, table rows, figures, and callouts.
- For DOCX-oriented source, keep styles simple and semantic: headings, paragraphs, lists, tables, figure captions, and page breaks. Avoid CSS effects that cannot survive office export, such as complex filters, fixed overlays, animated content, and nested scrolling regions.
- For agent handoff, return the preview URL, bundle/artifact IDs when available, source files, export assumptions, and the visual checks that still need to run outside the sandbox.
- For web-chat handoff, keep previews restartable: old inline previews should be stopped/unloaded by default after refresh, while the saved preview URL or artifact card remains available so the user can start a past preview again.
- Installed sandbox browser libraries are exposed from `/api/sandbox-libraries/` when the backend image has the npm packages installed. Use `/api/sandbox-libraries/catalog.json` to inspect availability.
- Good graph/chart defaults:
  - Chart.js: `<script src="/api/sandbox-libraries/chartjs/chart.umd.js"></script>`
  - D3: `<script src="/api/sandbox-libraries/d3/d3.min.js"></script>`
  - Mermaid: use `<script src="/api/sandbox-libraries/mermaid/mermaid.min.js"></script>` only when `/api/sandbox-libraries/catalog.json` reports it available; otherwise use the jsDelivr CDN fallback.
  - Cytoscape: `<script src="/api/sandbox-libraries/cytoscape/cytoscape.min.js"></script>`
  - Plotly: `<script src="/api/sandbox-libraries/plotly/plotly.min.js"></script>`
  - ECharts: `<script src="/api/sandbox-libraries/echarts/echarts.min.js"></script>`
  - vis-network: `<script src="/api/sandbox-libraries/vis-network/vis-network.min.js"></script>`
  - Force Graph: `<script src="/api/sandbox-libraries/force-graph/force-graph.min.js"></script>`
  - 3D Force Graph: `<script src="/api/sandbox-libraries/force-graph-3d/3d-force-graph.min.js"></script>`
- Good 3D/animation/design defaults:
  - Three.js: add `<script type="importmap">{"imports":{"three":"/api/sandbox-libraries/three/three.module.js","three/addons/":"/api/sandbox-libraries/three/addons/"}}</script>`, then use `import * as THREE from "three"` in a module script.
  - GSAP: `<script src="/api/sandbox-libraries/gsap/gsap.min.js"></script>`
  - Matter.js: `<script src="/api/sandbox-libraries/matter/matter.min.js"></script>`
  - p5.js: `<script src="/api/sandbox-libraries/p5/p5.min.js"></script>`
  - Rough.js: `<script src="/api/sandbox-libraries/rough/rough.js"></script>`
- Good code/document viewer defaults:
  - CodeMirror: `<link rel="stylesheet" href="/api/sandbox-libraries/codemirror/codemirror.min.css">` plus `<script src="/api/sandbox-libraries/codemirror/codemirror.min.js"></script>` and the needed mode scripts.
  - highlight.js: `<link rel="stylesheet" href="/api/sandbox-libraries/highlightjs/github.min.css">` plus `<script src="/api/sandbox-libraries/highlightjs/highlight.min.js"></script>`.
  - Marked: `<script src="/api/sandbox-libraries/marked/marked.min.js"></script>`
  - PDF.js: `<script src="/api/sandbox-libraries/pdfjs/pdf.min.js"></script>` plus worker setup.
  - Mammoth: `<script src="/api/sandbox-libraries/mammoth/mammoth.browser.min.js"></script>`
  - docx.js: `<script src="/api/sandbox-libraries/docx/docx.umd.min.js"></script>`
- Prefer generated SVG/PNG chart and diagram assets for documents that will export to PDF/PPTX or any external office format. Browser-only interactive charts are fine for HTML previews but should have static fallbacks for office formats.
- Use FastAPI in Python execution for API behavior checks, or produce a small static frontend that calls a documented API shape. A long-running FastAPI server is better handled by a managed app or remote build/deploy workflow rather than `mode: "execute"`.
