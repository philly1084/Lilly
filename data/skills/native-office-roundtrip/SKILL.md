Use this skill when the user asks for DOCX/Word, PDF, PPTX, XLSX, redlines, comments, document import/export, rendered document QA, or office-file round trips.

Current Lilly boundary:
- HTML, PDF, PPTX, XLSX, and Markdown are supported document outputs.
- DOCX/Word requests currently normalize to HTML unless a separate native conversion/export path is explicitly provided.
- Do not promise native DOCX as complete until the output is actually generated and opened/rendered or otherwise verified.

Workflow:
1. Build a compact document brief: format, audience, purpose, sections, tone, length, inputs, assets, constraints, and acceptance checks.
2. Resolve source and target: new artifact, edit existing artifact, convert, redline, comment, export, or render QA.
3. Choose the delivery path:
   - HTML/PDF/PPTX/XLSX/Markdown: use KimiBuilt document workflow.
   - DOCX: state the boundary and use external/native tooling only if configured.
4. Use structured blocks: headings, tables, callouts, figures, captions, references, page breaks, and stable section ids.
5. Render or preview in the target medium. Check contrast, text clipping, page breaks, images, captions, headers/footers, tables, and charts.
6. Preserve source, output artifact, and QA report together.

Return:
- `SOURCE`
- `TARGET_FORMAT`
- `OUTPUT`
- `NATIVE_OR_NORMALIZED`
- `QA_CHECKS`
- `ASSUMPTIONS`
- `REMAINING_LIMITS`
