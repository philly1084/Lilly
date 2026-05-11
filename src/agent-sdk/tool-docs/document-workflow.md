# Document Workflow

`document-workflow` recommends, plans, generates, assembles, and bundles document outputs.

Core actions:

- `recommend`: infer document type, format, templates, layout, and next action.
- `plan`: build a deterministic production plan before generation.
- `generate`: create one document or presentation.
- `assemble`: combine source material into one document.
- `generate-suite`: create a multi-format package such as PDF + HTML + PPTX + XLSX, with optional graph assets and a Vite/static preview bundle.

Current runtime formats:

- Supported generation outputs are `html`, `pdf`, `pptx`, `xlsx`, and `md`.
- `docx`, `doc`, and `word` requests currently normalize to `html`. Treat DOCX as future work or as an external conversion path that must be named and verified separately.
- Do not call sandbox HTML, Markdown, or a renamed file a finished DOCX/PDF/PPTX artifact.

Quality defaults:

- Every AI-backed generation request receives the built-in document quality standard: strategy architecture, background art direction, evidence editing, accessibility review, and final polish.
- PDF-oriented HTML should declare its intended page geometry with an explicit `@page size` and `margin` rule, and the design should be composed around that page size before export. Use the source HTML or design-plan geometry as the authority; only fall back to the default portrait `11.33in x 14.67in` with margins around `0.72in 0.65in 0.68in` when the source/design does not specify a page.
- Use a Kimi K2.6-style creation loop for document work: lock the user intent, separate known context from safe assumptions and blockers, architect the artifact, build it, critique the rendered result, repair issues, and hand off proof.
- The generated artifact or handoff should carry a compact user-alignment snapshot: user goal, audience, target format, purpose, assumptions, open questions, acceptance checks, verification plan, checks run, and checks still needed.
- Treat design-sensitive documents and sandbox websites as a Symphony-style build loop: plan the surface, generate the artifact, review rendered output, then iterate before final delivery when the review exposes template sameness, broken layout, auth walls, low contrast, missing assets, or thin content.
- Background creation is automatic. The workflow should define readable canvas, page, panel, dark band, table, chart, caption, and image-overlay surfaces without making the user ask for visual prompt details.
- Pass `qualityPass:false` only for explicit cost or latency-sensitive calls where the caller accepts lower polish.

Done means verified:

- The artifact exists and the response includes its artifact ID, download URL, preview URL, or saved file path.
- The handoff says what user outcome the document is meant to satisfy, what assumptions were made, what open questions remain, and which acceptance checks are already satisfied.
- HTML previews have been opened or checked with `node bin/kimibuilt-ui-check.js <url-or-file-url> --out ui-checks/<name>` when a browser is available.
- PDF output has been rendered or visually reviewed for page breaks, contrast, table splits, captions, headers/footers, and image quality.
- PPTX/XLSX outputs have been opened, rendered, or inspected with the available office/spreadsheet tooling before delivery when tooling exists.
- Static chart and diagram assets are included for DOC/PDF/PPTX-style exports; interactive browser-only charts need SVG/PNG fallbacks.
- The handoff names the source files, generated artifacts, checks run, failed checks fixed, and remaining assumptions.

Training and Manuals:

- Use `documentType: "training-manual"` for manuals, learner guides, facilitator guides, job aids, workbooks, SOP training, curriculum plans, and training packages.
- Prefer `plan` before generation when the request is broad or design-sensitive.
- Prefer `generate-suite` when the user asks for a package across PDF, XLSX, HTML, or markdown.
- Pass `graphs`/`diagrams` when the deliverable needs charts, network diagrams, flowcharts, timelines, architecture visuals, or other custom document graphics; the workflow will call `graph-diagram` and feed the generated visual assets into the document suite.
- Use `buildMode: "sandbox"` or `useSandbox: true` for previewable HTML/Vite document bundles rather than a bare template export.
- For website, web app, dashboard, landing-page, and UI mockup requests, build through the richer HTML artifact/frontend path and preserve the generated bundle as the preview entry. Do not wrap a single website mockup in a generic document-suite index unless the user asked for a multi-file document package.
- For website, dashboard, app workspace, landing-page, frontend demo, HTML prototype, or UI mockup requests, apply the Impressive Frontend Websites standard: infer a compact brief, make the first viewport specific to the product/workflow/offer/audience, use relevant visual assets, include real controls/states/interactions, verify desktop/mobile plus opened UI states, and iterate after the first render for non-trivial builds.
- When the request needs generated artwork or synthetic visuals, call `image-generate` before the document or HTML composition pass, allow it enough time to finish, and continue only after `usableCount`, `artifacts`/`artifactIds`, or `markdownImages` confirms at least one reusable image. If no reusable generated image is returned, surface the image diagnostic instead of shipping placeholders.
- Sandbox builds include an `AGENT_SANDBOX_BUILD.md` handoff prompt for the next agent. Keep that prompt capability-oriented: describe the sandbox constraints, available local browser libraries, relative-path rules, accessibility/readability checks, and preview expectations. Do not bake in a fixed visual style, palette, layout trope, or tool-orchestration chain.
- Treat sandbox build mode as a delivery switch, not permission to invent nested tool workflows. The build agent should use the files and tools already available in the sandbox project and choose design ideas from the user task, audience, and content.
- Sandbox document builds are previews and source bundles. Export through the real document path for PDF/PPTX/XLSX/Markdown, and record that DOCX is not native unless a separate conversion step exists.
- For interactive HTML documents, dashboards, graph explorers, and 3D explainers, prefer local sandbox browser library routes from `/api/sandbox-libraries/` before external CDNs. Common choices include Three.js, Chart.js, D3, Mermaid, Cytoscape, Plotly, ECharts, vis-network, GSAP, Matter.js, p5.js, Rough.js, Force Graph, and 3D Force Graph.
- Ask only high-impact design questions when audience, delivery mode, duration, format mix, research depth, assessment style, or visual direction would materially change the output. Otherwise infer conservative defaults and record them.
- Ground subject-specific training in vector context and verified web research when the user asks for current facts, standards, procedures, or domain-specific instruction.

Podcast and video podcast training:

- Use `document-workflow` for planning briefs, scripts, worksheets, and supporting documents.
- Use `podcast` for actual audio and MP4 generation.
- For large packages, split work by surface: manual, workbook, HTML page, podcast script, video-podcast storyboard, research, and QA.
