# graph-diagram

Purpose: generate reusable graph, chart, and diagram assets for agents, documents, decks, PDFs, and HTML artifacts.

Use when:
- a document or deck needs one or more diagram images
- another agent can consume native graph JSON
- a workflow needs both editable diagram source and a rendered visual
- multiple graph images should be generated in one batch

Inputs:
- `graph` for one diagram or `graphs` for a batch
- `nodes` and `edges` for network/flow diagrams
- `data` or `series` for bar/line/scatter charts
- `source` for native JSON or existing Mermaid source
- `insightTitle`, `summary`, and `altText` for the Web Chat card and non-visual reading path
- `sourceLabel`, `sourceUrl`, and `caveat` for evidence context kept with the visualization
- `outputFormats`: `native`, `mermaid`, `dot`, `svg`, `html`
- `renderMode`: `artifact`, `svg`, `html`, `sandbox-project`, or `native`

Outputs:
- `graphs[].native`: structured graph data for other agents/tools
- `graphs[].formats.mermaid`: Mermaid source
- `graphs[].formats.dot`: Graphviz DOT source
- `graphs[].formats.svg`: self-contained SVG
- `graphs[].formats.html`: preview document with SVG and source panels
- `images[]` and `markdownImages[]`: persisted SVG image artifact references when a session is active
- persisted artifacts include `metadata.visualization`, which Web Chat renders as a claim-led visualization card with source, caveat, and a data or relationship outline

Model guidance:
- With GPT-5.5 or newer, prefer SVG output for high-fidelity custom diagrams.
- Keep Mermaid/DOT/native JSON enabled when editability or downstream graph processing matters.
