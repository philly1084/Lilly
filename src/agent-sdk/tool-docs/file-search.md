# file-search

Purpose: list local runtime files that match a glob pattern so an agent can find editable source before reading or writing.

Use when:
- The user wants to improve, update, or inspect existing code, HTML, CSS, documents, or assets.
- A frontend follow-up should work like an IDE by finding likely files before reading or editing them.

Key params:
- `pattern`: glob pattern such as `frontend/web-chat/**/*.{js,css,html}` or `**/*.{html,css,js}`.
- `cwd`: optional working directory for the glob.

Example:
```json
{"pattern":"frontend/web-chat/**/*.{js,css,html}","cwd":"."}
```

Failure modes:
- The pattern is too broad and returns noisy results.
- The target path is outside the runtime workspace.

Verification:
- Follow with `file-read` for selected files, then focused tests or UI checks before finalizing an edit.
