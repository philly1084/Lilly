# Scenery and environments

Open **Create → Scenery**, choose a connected AI model, and describe the setting, terrain, plants, landmarks and atmosphere. Forest, Desert and Snow fill the prompt with examples. Generate, rotate the preview, then **Apply environment**. Follow-up requests receive the saved environment recipe, so you can ask for changes to the existing design.

Each proposal compiles data into real GLB geometry before it is offered for application. The landscape preview is also downloadable as a single GLB. Applying saves the individual reusable models, their editable model recipes, a native height-map terrain, its material, the environment recipe and scene lighting together. Existing game entities stay in place; previous Lilly scenery in this scene is replaced. Undo restores the prior scene and terrain files while retaining the generated model library. Proposals enforce their original revision and cannot overwrite intervening project edits.

Terrain and decorative scenery use deterministic placement. Spawn areas, existing colliders and ground footprints reserve clear space. Terrain heights flatten around these areas. The editor and built player follow the same terrain triangles when walking. Decorative props do not have solid collision. This is a stylized static scenery workflow; it does not generate rigged characters or simulate erosion, water or foliage physics.

## Codex and agent access

Use the existing authenticated Lilly CLI connection:

```sh
lilly-game ai --project PROJECT_ID --base-revision REVISION --mode environment --model gpt-6-astra --prompt "A misty pine woodland with mossy rocks and an ancient arch"
lilly-game ai-apply --project PROJECT_ID --run RUN_ID
```

The selected model must be available on the configured gateway. Codex can author the data directly with `--mode environment --recipe environment.json`. The `game-studio` tool also accepts action `generate-environment`, followed by `apply-ai-run` using the returned ID. A failed model request reports an error rather than silently substituting a preset.

The recipe schema is `LillyEnvironmentRecipe/v1`:

- `name`, `seed`: saved identity and repeatable placement seed.
- `terrain`: `size: [width, depth]` (16–96 meters), `height` (0–12 meters), hex `color`, and up to 12 `hills` with normalized `center: [x,z]`, `radius` (0.1–1.5), and normalized `height` (0–1).
- `sky`: hex `color`, `ambient` (0.2–2), hex `sunColor`, `sunIntensity` (0–5), and optional `fog: {color, near, far}`. Near is 5–120 meters; far is 20–240 and must exceed near.
- `models`: 1–6 objects with unique lowercase `id` and a valid `LillyModelRecipe/v1` in `recipe`. Each model must fit within 16 meters.
- `scatter`: up to eight groups with `modelId`, `count` (1–40), optional normalized `center`, `radius`, and `scale: [min,max]` (0.2–3).
- `placements`: up to 16 landmarks with `modelId`, normalized `point: [x,z]`, optional degree `yaw` and uniform `scale` (0.2–3).

Combined placement requests are limited to 96 objects and 180,000 rendered triangles. The combined GLB is limited to 8 MB. Objects that cannot fit without crowding are omitted with a visible count. All positions use Y-up meters, ground-centered model pivots, and normalized terrain X/Z coordinates from -1 to 1. The service validates model data and never executes code from an environment recipe.

## Verification

`src/game-studio/environment-creator.test.js` exercises deterministic GLBs, terrain triangles, selected-model forwarding, ownership, stale revisions, native resources, file read-back, replacement, undo/redo, playtest and built asset inclusion. Run it after `npm run build:lilly-engine`. Browser verification must include the Scenery preview and application on desktop and mobile.
