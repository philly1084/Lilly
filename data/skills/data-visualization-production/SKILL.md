Use this skill when the user asks to compare, explain, monitor, map, schedule, or explore data visually, or when a chart, diagram, dashboard, interactive report, or Web Chat visualization card would make the answer materially easier to understand.

Planning contract:
- Name the analytical job and data shape before choosing a renderer.
- Write a claim-style `insightTitle`; keep the main evidence visible without hover.
- Record the audience, units, source, update time when relevant, missingness or uncertainty, and one concrete caveat.
- Treat desktop and mobile portrait as sibling layouts. Put the main evidence before secondary controls on mobile.
- Use neutral context, one focal accent, and a separate alert treatment. Do not encode meaning by color alone.
- Prefer a table when precise lookup is the job. Prefer bars or dots for comparison, lines or small multiples for time, distribution plots for spread, scatterplots for relationships, and maps only when geography matters.

Renderer route:
- Use `graph-diagram` for standard bar, line, scatter, timeline, network, tree, flowchart, sequence, state, ER, class, architecture, and other durable SVG-first views.
- Pass `insightTitle`, `summary`, `altText`, `sourceLabel`, `sourceUrl`, and `caveat` with the graph spec. Keep `persistArtifacts:true` so Web Chat receives a durable visualization card.
- Use `code-sandbox` in project mode for histograms, intervals, matrices, maps, Gantt views, coordinated dashboards, streaming state, custom D3/Canvas rendering, or interactions that do not fit the SVG utility. Prefer installed `/api/sandbox-libraries/` routes and emit a previewable HTML artifact.
- Use `document-workflow` when the target is PDF, PPTX, XLSX, Markdown, or a composed visual report. Generate reusable chart/diagram assets before embedding.
- Use WebGL, 3D, particles, motion, or a contextual substrate only when it carries analytical meaning. Provide a static or reduced-motion fallback.

Web Chat card contract:
- A visualization is not only a downloadable file. Its card must expose the claim title, chart family, takeaway, source or method, caveat, and a non-visual data or relationship outline.
- Essential values must remain available through direct labels or the card's data/diagram details; tooltips are supplementary.
- Interactive HTML artifacts own filters, selections, zoom, URL state, stale/live/offline status, and saved-view behavior. The surrounding Web Chat card owns the stable summary and fallback.

Verification:
- Check data transforms, sorting, aggregation, domains, units, labels, and source/caveat truth before visual polish.
- Use deterministic fixtures for focused tests.
- Run desktop and mobile browser QA for clipping, horizontal page overflow, unreadable text, tiny touch targets, hover-only evidence, broken images, blank frames, and console or network errors.
- Keep wide fallback tables scrollable inside the visualization card so the chat page itself remains anchored.
- For live data, keep last-known-good evidence visible and label live, stale, partial, offline, and reconnecting states.

Return:
- `ANALYTICAL_JOB`
- `ARTIFACT_FAMILY`
- `PRIMARY_ROUTE`
- `FALLBACK`
- `IMMEDIATE_EVIDENCE`
- `ACCESSIBLE_PATH`
- `SOURCE_AND_CAVEAT`
- `MOBILE_PATH`
- `QA_CHECKS`
