# Notes Database Blocks

AGENT_DOC_METADATA: size=small; complexity=medium; read_time=2m; skip_when=task does not touch Notes database blocks, spreadsheet-like tables, xlsx-style page parts, or database output metadata
GREP_HANDLES: NOTES_DATABASES NOTES_FRONTEND DATABASE_BLOCK XLSX_STYLE_TABLE SPREADSHEET_SCROLL DATABASE_METADATA

Purpose: compact context for agents editing or generating spreadsheet-like database blocks in `frontend/notes-notion`.

Read when:
- A task mentions Notes databases, xlsx-style page parts, spreadsheet tables, horizontal table viewing, database block rendering, database rows/columns, or database metadata.
- You need to decide whether to patch the renderer, parser, export, or agent-output contract.

Skip when:
- The task is about Admin dashboard tables, generated XLSX artifacts, chart blocks, Mermaid diagrams, or image blocks.

Implementation map:
- Renderer: `frontend/notes-notion/js/blocks.js`, `renderDatabaseBlock()`, `normalizeDatabaseContent()`, `estimateDatabaseColumnWidth()`.
- Styles: `frontend/notes-notion/css/styles.css`, `.database-scroll-region`, `.database-table`, `.database-row`, `.database-cell`.
- Override layer: `frontend/notes-notion/css/notion-refinements.css`, `.database-table` and database mobile/layout rules.
- Agent action normalization: `frontend/notes-notion/js/agent.js` maps structured database actions into Notes `database` blocks.
- Query/index context: `frontend/notes-notion/js/notes-query.js` includes database rows and headers in searchable page context.
- Export surfaces: `frontend/notes-notion/js/import-export.js` exports database blocks to HTML/Markdown/text fallbacks.

Current rendering contract:
- Database blocks are spreadsheet-like horizontal scroll regions, not compressed mobile cards.
- `renderDatabaseBlock()` sets `--database-table-min-width` from the estimated sum of column widths.
- `.database-scroll-region` owns horizontal scrolling so desktop split panes and mobile widths can pan across all columns without causing whole-page horizontal overflow.
- `.database-table` should remain a single full-width track using `width: max(100%, var(--database-table-min-width, 480px))`.
- Rows, header cells, action cells, and add-row/add-column controls should stay aligned on that table track.

Agent output contract:
- Prefer a normal Notes block shape:
  `{ "type": "database", "content": { "columns": ["Name", "Status"], "rows": [["Task", "Open"]] } }`
- Object rows are accepted and normalized onto declared columns when possible.
- Keep columns meaningful and short. Use additional rows for long notes instead of cramming paragraphs into headers.

Verification:
- Run focused normalization coverage when changing data shape handling: `npm test -- --runInBand frontend/notes-notion/js/blocks.test.js frontend/notes-notion/js/agent.parse.test.js`.
- Run a browser proof on `http://127.0.0.1:3000/notes/index.html?__kb_full=1` for renderer/CSS changes.
- Check desktop and mobile widths for database-region horizontal scrolling, no whole-page horizontal overflow, readable cells, aligned headers/rows, and no console errors.
