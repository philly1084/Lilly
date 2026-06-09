# file-write

Purpose: write a full local runtime file body and mirror the output into a session artifact when possible.

Use when:
- The user asks to save or update a local generated file and the full intended content is available.
- A targeted source edit has already been reasoned through and the complete replacement body is necessary.

Key params:
- `path`: destination path.
- `content`: full file body to write in the same call.
- `encoding`: optional text encoding, defaults to `utf8`.

Example:
```json
{"path":"output/example.html","content":"<!doctype html><html><body>Done</body></html>"}
```

Failure modes:
- Missing `content`; this tool cannot write by referring to an earlier artifact alone.
- Using it for remote hosts or deployed servers; use `remote-cli-agent`, `remote-workbench`, or managed-app lanes there.

Verification:
- For reusable frontend work, read/search first and avoid full-file replacement when a smaller patch or repo edit path is available. Run syntax/tests and browser or `kimibuilt-ui-check` proof after writing.
