# file-read

Purpose: read a specific local runtime file after the agent has identified that it is relevant.

Use when:
- The user references an existing file, artifact source, or frontend project.
- A follow-up should preserve current source instead of hallucinating a replacement file.

Key params:
- `path`: exact file path to read.
- `encoding`: optional text encoding, defaults to `utf8`.

Example:
```json
{"path":"frontend/web-chat/js/app.js"}
```

Failure modes:
- The file does not exist.
- The file is too large for useful context and should be narrowed by grep or a smaller target.

Verification:
- Pair with `file-search` or grep-style discovery before broad reads, then apply targeted edits and run focused checks.
