Use this skill when the user asks to create a book, guide, long-form article package, researched HTML, PDF, visual report, or multi-section content project with images and multi-agent section work.

Operating model:
- Treat the index as the contract. Do not start bulk drafting until the index defines sections, source needs, visual needs, output paths, and acceptance checks.
- Keep section agents fresh by giving each one a section packet plus selected research-bucket/file paths. Do not pass the whole transcript, hidden conclusions, or one giant shared context.
- Use immediate bounded `agent-delegate` bursts for section work. Do not create one deferred `agent-workload` per section unless the user explicitly asks for later/scheduled work.
- Cap each burst to the runtime limit and use distinct write targets. If more sections exist, run multiple bursts in waves.
- Let the master agent review artifacts from disk with grep/search and explicit rubrics, then send exact rebuild packets only for sections with issues.

Workflow:
1. Brief and format lock
   - Capture: title/topic, audience, purpose, tone, length, output formats, image style, source standards, deadline, and acceptance checks.
   - If details are missing, use conservative professional defaults and record assumptions in the project manifest.
   - Decide whether the final deliverable is responsive HTML, PDF-oriented HTML, exported PDF, Markdown, or a multi-format suite.

2. Research and source bundle
   - Use freshness-aware `web-search`; prefer `pro-search` or larger extraction budgets for source-heavy work.
   - Verify selected pages with `web-fetch`; use `web-scrape` only for rendered pages, structured fields, or screenshots.
   - Store durable project material in the research bucket:
     - `refs/source-notes.md` or source-note files
     - `images/image-plan.md` plus generated or sourced asset refs
     - `data/` or `graphs/` for structured evidence and diagrams
   - Keep citation notes short and attributable: source title, URL, date accessed, useful facts, caveats, and section relevance.

3. Designed index
   - Produce an index before section bursts:
     - section id and title
     - reader promise
     - target word range
     - required sources
     - image/figure/table ideas
     - cross-links to other sections
     - output path
     - acceptance checks
   - Include front matter, intro, chapters/sections, conclusion, references, image credits, and optional appendices.
   - For PDF-oriented output, define page geometry and print rules before layout work.

4. Fresh section packets
   - Write one packet per section, for example `sections/03-market-context/packet.md`.
   - Each packet includes only:
     - project brief summary
     - index entry for that section
     - allowed source-note paths and asset paths
     - citation style
     - neighboring section summaries when needed
     - exact output path
     - four-step build rubric
   - Keep packets compact. If a source is long, reference the path and quote only the needed snippet.

5. Four-step section build burst
   - For each section agent, instruct it to perform these four steps:
     1. Evidence pass: read the packet and selected sources; list key claims, source refs, and gaps.
     2. Structure pass: draft the section outline, callouts, figures, captions, and transitions.
     3. Composition pass: write the section in the target format with citations, alt text, and figure/table placeholders or assets.
     4. Self-review pass: check against the packet acceptance checks and write a short `SECTION_STATUS` block.
   - Use `agent-delegate` with clear `writeTargets` and output paths. Do not let section agents overwrite the index, manifest, or other sections.
   - When images are needed, generate/source them before final assembly or give the section agent explicit image refs to wire in.

6. Master grep and review
   - After a burst, the master reads the index, manifest, section outputs, source notes, and status blocks.
   - Search for blockers:
     - missing sections or wrong paths
     - TODO/TBD/placeholders
     - unsupported claims or citation drift
     - duplicated headings or repeated paragraphs
     - broken cross-links
     - missing alt text, captions, image credits, or figure references
     - tone/style mismatch across sections
     - low-contrast or print-risky design tokens
     - horizontal overflow, clipped labels, or page-break risks in HTML/PDF
   - Create rebuild packets with exact file, issue, required change, relevant source refs, and acceptance check. Do not send vague "improve this" rebuild prompts.

7. Rebuild loop
   - Re-run bursts only for failed sections or shared assets.
   - Give rebuild agents the original section packet plus the rebuild packet; avoid injecting the full review narrative.
   - The master repeats grep/review until no blockers remain or a real blocker is reported.

8. Assembly and verification
   - Use `document-workflow` to assemble final HTML/PDF/Markdown suites or source bundles.
   - For HTML previews, run browser/UI checks and inspect desktop/mobile rendering.
   - For PDF, render or visually review page breaks, captions, image quality, contrast, headers/footers, and table splits.
   - Handoff must include source paths, generated artifact paths or URLs, checks run, fixed issues, remaining assumptions, and any sections that still need human approval.

Return:
- `PROJECT_MANIFEST`
- `DESIGNED_INDEX`
- `SOURCE_BUNDLE`
- `SECTION_PACKETS`
- `BURST_PLAN`
- `MASTER_REVIEW`
- `REBUILD_PACKETS`
- `FINAL_ARTIFACTS`
- `VERIFICATION`
