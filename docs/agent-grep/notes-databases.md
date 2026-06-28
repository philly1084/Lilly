# Notes Databases

GREP_HANDLES: AGENT_DOC NOTES_DATABASES NOTES_FRONTEND DATABASE_BLOCK XLSX_STYLE_TABLE SPREADSHEET_SCROLL DATABASE_METADATA
AGENT_DOC_METADATA: size=tiny; complexity=low; read_time=1m; skip_when=task does not mention Notes databases, spreadsheet tables, xlsx-style blocks, or database metadata

Use when:
- A task says Notes databases, xlsx-style page parts, spreadsheet-like tables, database blocks, horizontal table viewing, or database metadata.
- An agent is deciding whether database context is worth reading before editing Notes.

Fast path:
1. Read `frontend/notes-notion/docs/databases.md`.
2. Inspect `frontend/notes-notion/js/blocks.js` around `renderDatabaseBlock`.
3. Inspect `frontend/notes-notion/css/styles.css` around `.database-scroll-region`.
4. Check the override layer in `frontend/notes-notion/css/notion-refinements.css`.
5. Prove the served route: `http://127.0.0.1:3000/notes/index.html?__kb_full=1`.

Skip this doc for:
- Admin dashboard tables.
- Generated `.xlsx` file artifacts.
- Notes chart blocks.
