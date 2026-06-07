Use this skill when the user asks for DOCX/Word, PDF, PPTX, XLSX, redlines, comments, document import/export, rendered document QA, or office-file round trips.

Current Lilly boundary:
- HTML, PDF, PPTX, XLSX, and Markdown are supported document outputs.
- DOCX/Word requests currently normalize to HTML unless a separate native conversion/export path is explicitly provided.
- Do not promise native DOCX as complete until the output is actually generated and opened/rendered or otherwise verified.

Workflow:
1. Build a compact document brief: format, audience, purpose, sections, tone, length, inputs, assets, constraints, and acceptance checks.
   - Decide `checkpoint needed?` before drafting. Ask one or two concise clarification questions only when missing context would materially change the document, make the draft misleading, or block a credible artifact.
   - If a checkpoint is not needed, continue with explicit assumptions in metadata or handoff notes.
   - Use higher reasoning effort for document creation, revision, and QA unless the user explicitly asks for a quick/low-effort draft.
2. Resolve source and target: new artifact, edit existing artifact, convert, redline, comment, export, or render QA.
3. Choose the delivery path:
   - HTML/PDF/PPTX/XLSX/Markdown: use KimiBuilt document workflow.
   - DOCX: state the boundary and use external/native tooling only if configured.
4. Lock the document purpose and build to the subject, not to template slots. Every section must have a reader job tied to the actual topic, audience, and purpose.
5. Use structured blocks: headings, tables, callouts, figures, captions, references, page breaks, and stable section ids.
6. Remove boilerplate, placeholder prose, and expressions of what a section should contain. If there is not enough context for a section, omit it, ask a checkpoint question, or state a bounded assumption/limit.
7. Render or preview in the target medium. Check contrast, text clipping, page breaks, images, captions, headers/footers, tables, charts, and subject-specific content depth.
8. Preserve source, output artifact, and QA report together.

Return:
- `SOURCE`
- `TARGET_FORMAT`
- `OUTPUT`
- `NATIVE_OR_NORMALIZED`
- `QA_CHECKS`
- `ASSUMPTIONS`
- `REMAINING_LIMITS`
