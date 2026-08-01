# Lilly Game Studio rollout

`GAME_STUDIO_ENABLED` gates the editor route, API, and unified tool. The checked-in k3s and Rancher ConfigMaps default it to `false`; `GAME_STUDIO_WEBGPU_EXPERIMENTAL` also remains `false`.

## Release sequence

1. Build the engine and editor with `npm run build:game-studio:all`.
2. Run `npm run test:game-studio` plus the security and sandbox-library route tests.
3. Start the backend with an isolated `KIMIBUILT_DATA_DIR` and `GAME_STUDIO_ENABLED=true`.
4. Run `node bin/kimibuilt-ui-check.js <origin>/game-studio/` at 1280x720, 1440x900, 1920x1080, and 390x844.
5. Run `npm run smoke:game-studio -- --url <origin>/game-studio/`. The smoke covers hierarchy and inspector edits, drag-to-reparent, typed Blueprint connection and compilation, AI review/apply, play/pause/step, immutable build, sandbox replay, save bridging, publication failure preservation, and rollback.
6. Publish the image, update the backend deployment, and verify readiness before enabling the flag.
7. Set `GAME_STUDIO_ENABLED=true`, restart the backend, and repeat the UI and smoke checks against the authenticated public route.
8. Publish the tested canary build through managed apps. Keep its private preview available until the public HTTPS route, deployment, and browser replay are all verified.

## Production acceptance

- Saved project revision and revision-conflict proof.
- Valid and compiled Blueprint graphs.
- Playable editor preview with no blank WebGL output or page errors.
- Automated control test and bridged save/reset.
- Immutable build files tied to one project revision.
- Managed-app build run and k3s rollout succeed.
- Concrete `*.demoserver2.buzz` TLS URL returns the canary.
- Public browser replay passes controls, pickups, score, win state, audio, particles, HUD, save, and reset.

## Rollback

Disable `GAME_STUDIO_ENABLED` and restart the backend to remove the authoring surface without deleting project data or builds. Published games remain immutable managed-app revisions and can be rolled back through their existing deployment history. Project rollback creates a new revision from the selected earlier snapshot; it never rewrites revision history.
