# Legacy canvas audit

The served `/canvas` route uses `frontend/canvas-excalidraw`; that active board, `/api/canvas`, artifact workflows, and its tests remain intact.

The separate tracked `frontend/canvas` directory had no server registration, package script, workflow entry, import, or runtime reference outside its own files. Its reusable behavior was an editor, undo/history, canvas-type switching, artifact calls, and export helpers. Lilly Game Studio now provides Monaco editing, transactional command history with undo/redo, typed Blueprint editing, immutable builds, private previews, and publishing handoff. The unserved directory was therefore removed after the reference audit.

Generated game artifacts are not auto-converted. Compatible HTML/Three.js bundles remain playable and may be brought into Game Studio only through the explicit import path.
