'use strict';

const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');

const PLAYER_JAVASCRIPT = fsSync.readFileSync(path.join(__dirname, 'player-runtime.js'), 'utf8');
const MODULE_SANDBOX_JAVASCRIPT = fsSync.readFileSync(path.join(__dirname, 'module-sandbox-runtime.js'), 'utf8');
const GAMEPLAY_JAVASCRIPT = fsSync.readFileSync(path.join(__dirname, '../../packages/lilly-engine/browser-dist/index.js'), 'utf8');
const PLAYER_RUNTIME_HASH = crypto.createHash('sha256')
  .update(PLAYER_JAVASCRIPT)
  .update(MODULE_SANDBOX_JAVASCRIPT)
  .update(GAMEPLAY_JAVASCRIPT)
  .update(buildIndexHtml.toString())
  .update(String(require('three').REVISION || 'unknown'))
  .digest('hex')
  .slice(0, 12);

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[character]));
}

function buildIndexHtml(project) {
  const title = escapeHtml(project.name || 'Lilly Game');
  const levelRecipe = (project.levelRecipes || []).find((recipe) => recipe.sceneId === project.entryScene) || null;
  const levelDesign = levelRecipe
    ? (project.generatedLevels || []).find((design) => design.recipeId === levelRecipe.id) || null
    : null;
  const levelLabel = escapeHtml(levelRecipe?.name || project.name || 'Generated level');
  const pickupCount = Number(levelDesign?.metrics?.pickupCount || 0);
  const encounterCount = Number(levelDesign?.metrics?.encounterCount || 0);
  const enemyCount = Number(levelDesign?.metrics?.enemyCount || 0);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#071018" />
  <link rel="icon" href="data:," />
  <title>${title}</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#05090e;color:#edf7ff;--safe-top:max(14px,env(safe-area-inset-top));--safe-right:max(14px,env(safe-area-inset-right));--safe-bottom:max(14px,env(safe-area-inset-bottom));--safe-left:max(14px,env(safe-area-inset-left))}
    *{box-sizing:border-box}html,body,#game-canvas{width:100%;height:100%;margin:0;overflow:hidden}body{overscroll-behavior:none}button{font:inherit}#game-canvas{display:block;background:#081018;touch-action:none}
    .hud{position:fixed;inset:0;pointer-events:none;padding:var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);display:flex;flex-direction:column;justify-content:space-between;z-index:2}
    .hud-row{display:flex;justify-content:space-between;align-items:flex-start;gap:14px}.panel{background:rgba(7,15,23,.86);border:1px solid rgba(125,211,252,.24);box-shadow:0 18px 60px rgba(0,0,0,.3);backdrop-filter:blur(12px);border-radius:12px;padding:11px 13px}
    .eyebrow{font-size:9px;letter-spacing:.15em;text-transform:uppercase;color:#7dd3fc}.level-name{max-width:min(62vw,420px);margin-top:3px;color:#d9e8f2;font-size:11px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.score-line{display:flex;align-items:flex-end;gap:14px;margin-top:7px}.score{font-size:26px;font-weight:780;line-height:1}.health,.combat{font-size:11px;color:#fda4af}.health strong{font-size:16px;color:#fecdd3}.combat{color:#bae6fd}.combat strong{font-size:16px;color:#7dd3fc}.objective{max-width:min(70vw,500px);font-size:12px;line-height:1.45;color:#c9d8e6;margin-top:5px}
    .status{font-size:10px;font-weight:750;color:#7dd3fc;background:rgba(7,15,23,.84);border:1px solid currentColor;border-radius:999px;padding:7px 10px;backdrop-filter:blur(10px)}.status[data-state=success]{color:#6ee7b7}.status[data-state=warning]{color:#fbbf24}
    .controls{pointer-events:auto;align-self:flex-end;display:flex;align-items:center;gap:7px}.controls span{font-size:10px;color:#9fb2c4;margin-right:5px}.controls button{min-height:38px;border:1px solid #314657;background:#101b25;color:#edf7ff;border-radius:9px;padding:8px 12px;cursor:pointer}.controls button:hover,.controls button:focus-visible{border-color:#38bdf8;background:#14283a;outline:2px solid rgba(56,189,248,.22);outline-offset:2px}
    .touch-controls{display:none;pointer-events:auto;position:fixed;left:var(--safe-left);bottom:var(--safe-bottom);z-index:3;width:142px;height:142px;grid-template-columns:repeat(3,44px);grid-template-rows:repeat(3,44px);gap:5px;touch-action:none}.touch-controls button{border:1px solid rgba(125,211,252,.38);border-radius:14px;background:rgba(8,19,27,.82);color:#e0f2fe;font-size:20px;font-weight:800;box-shadow:0 8px 22px rgba(0,0,0,.3);backdrop-filter:blur(10px);touch-action:none;user-select:none;-webkit-user-select:none}.touch-controls button[data-pressed=true]{background:#1d6587;border-color:#7dd3fc;transform:scale(.96)}.touch-up{grid-column:2;grid-row:1}.touch-left{grid-column:1;grid-row:2}.touch-down{grid-column:2;grid-row:3}.touch-right{grid-column:3;grid-row:2}
    .touch-action{display:none;pointer-events:auto;position:fixed;right:var(--safe-right);bottom:calc(var(--safe-bottom) + 62px);z-index:4;width:74px;height:74px;border:1px solid rgba(251,113,133,.58);border-radius:50%;background:rgba(72,18,31,.84);color:#fff1f2;font-size:12px;font-weight:850;letter-spacing:.08em;text-transform:uppercase;box-shadow:0 12px 30px rgba(0,0,0,.38);touch-action:none;user-select:none;-webkit-user-select:none}.touch-action[data-pressed=true]{background:#be123c;transform:scale(.95)}
    .loading,.error{position:fixed;inset:0;display:grid;place-items:center;background:#071018;z-index:5}.loading[hidden],.error[hidden]{display:none}.loading-card,.error-card{width:min(420px,calc(100vw - 32px));padding:24px;border:1px solid #24394a;border-radius:14px;background:#0c1721;box-shadow:0 28px 80px rgba(0,0,0,.45)}.loading-card p,.error-card p{color:#9fb2c4;line-height:1.5}.spinner{width:26px;height:26px;border:2px solid #274254;border-top-color:#38bdf8;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:16px}@keyframes spin{to{transform:rotate(360deg)}}
    @media (pointer:coarse),(hover:none){.touch-controls{display:grid}.touch-action{display:block}.controls span{display:none}.controls{margin:0 86px 0 155px}.controls button{min-width:64px;min-height:44px}}
    @media(max-width:600px){.hud{padding-top:var(--safe-top)}.hud-row{gap:8px}.panel{padding:9px 10px;border-radius:10px}.hud-row .panel{max-width:calc(100vw - 98px)}.score{font-size:22px}.objective{font-size:10px;max-width:100%}.level-name{max-width:52vw}.status{font-size:9px;padding:6px 8px}.controls{padding:6px;gap:5px}.controls button{padding:7px 9px}.touch-controls{width:132px;height:132px;grid-template-columns:repeat(3,40px);grid-template-rows:repeat(3,40px);gap:5px}.score-line{gap:10px}.health,.combat{font-size:9px}.health strong,.combat strong{font-size:14px}}
    @media(prefers-reduced-motion:reduce){.spinner{animation-duration:1.6s}.touch-controls button,.touch-action{transition:none}}
  </style>
</head>
<body>
  <canvas id="game-canvas" tabindex="0" aria-label="${title} game viewport"></canvas>
  <div class="hud">
    <div class="hud-row">
      <div class="panel">
        <div class="eyebrow">Lilly generated expedition</div>
        <div class="level-name" id="level-name">${levelLabel}</div>
        <div class="score-line"><div class="score"><span id="score-value">0</span> / <span id="score-total">${pickupCount}</span></div><div class="health">Shield <strong id="health-value">3</strong></div>${encounterCount ? `<div class="combat">Guardians <strong id="enemy-value">${enemyCount}</strong></div>` : '<span id="enemy-value" hidden>0</span>'}</div>
        <div class="objective" id="objective">Reach the first objective.</div>
      </div>
      <div class="status" id="status-pill" data-state="playing">Playing</div>
    </div>
    <div class="controls panel"><span>WASD move · Space attack · R reset</span><button id="save-button" type="button">Save</button><button id="reset-button" type="button">Reset</button></div>
  </div>
  <div class="touch-controls" aria-label="Touch movement controls">
    <button class="touch-up" type="button" data-move-code="KeyW" aria-label="Move forward">↑</button>
    <button class="touch-left" type="button" data-move-code="KeyA" aria-label="Move left">←</button>
    <button class="touch-down" type="button" data-move-code="KeyS" aria-label="Move backward">↓</button>
    <button class="touch-right" type="button" data-move-code="KeyD" aria-label="Move right">→</button>
  </div>
  <button class="touch-action" id="attack-button" type="button" aria-label="Attack">Strike</button>
  <div id="loading" class="loading"><div class="loading-card"><div class="spinner"></div><strong>Building ${levelLabel}</strong><p>Replaying the saved Lilly level recipe and preparing the WebGL2 runtime...</p></div></div>
  <div id="error-overlay" class="error" hidden><div class="error-card"><div class="eyebrow">Runtime error</div><h1>Game could not start</h1><strong>Unknown error</strong><p>Open Build Output in Lilly Game Studio for diagnostics.</p></div></div>
  <script type="importmap">{"imports":{"three":"./vendor/three.module.js","three/addons/":"./vendor/addons/"}}</script>
  <script type="module" src="./player.js"></script>
</body>
</html>`;
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    sizeBytes: buffer.length,
  };
}

function buildModuleSandboxHtml(moduleBundle) {
  const serialized = JSON.stringify(moduleBundle || { schema: 'LillyModuleBundle/v1', sourceHash: '00000000', loadOrder: [], modules: [], systems: [], mechanics: [], prefabs: [], tests: [], materials: [], assets: [], animations: [], terrains: [], diagnostics: [] })
    .replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; worker-src blob:; connect-src 'none'; img-src 'none'; media-src 'none'; style-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" />
  <title>Lilly module sandbox</title>
</head>
<body>
  <script>globalThis.__LILLY_MODULE_BUNDLE__ = ${serialized};</script>
  <script>${MODULE_SANDBOX_JAVASCRIPT.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>`;
}

async function writeImmutableBuild({ directory, project, graphIr, moduleBundle, projectDirectory = '' }) {
  moduleBundle = moduleBundle || { schema: 'LillyModuleBundle/v1', sourceHash: '00000000', loadOrder: [], modules: [], systems: [], mechanics: [], prefabs: [], tests: [], materials: [], assets: [], animations: [], terrains: [], diagnostics: [] };
  await fs.mkdir(directory, { recursive: false });
  const threeBuildDirectory = path.dirname(require.resolve('three'));
  const [threeModule, threeCore, gltfLoader, bufferGeometryUtils, skeletonUtils] = await Promise.all([
    fs.readFile(path.join(threeBuildDirectory, 'three.module.js'), 'utf8'),
    fs.readFile(path.join(threeBuildDirectory, 'three.core.js'), 'utf8'),
    fs.readFile(path.join(threeBuildDirectory, '../examples/jsm/loaders/GLTFLoader.js'), 'utf8'),
    fs.readFile(path.join(threeBuildDirectory, '../examples/jsm/utils/BufferGeometryUtils.js'), 'utf8'),
    fs.readFile(path.join(threeBuildDirectory, '../examples/jsm/utils/SkeletonUtils.js'), 'utf8'),
  ]);
  const levelDesign = (project.generatedLevels || []).find((design) => design.sceneId === project.entryScene) || null;
  const files = [
    ['index.html', buildIndexHtml(project)],
    ['player.js', PLAYER_JAVASCRIPT],
    ['gameplay.js', GAMEPLAY_JAVASCRIPT],
    ['module-sandbox.html', buildModuleSandboxHtml(moduleBundle)],
    ['modules.json', `${JSON.stringify(moduleBundle, null, 2)}\n`],
    ['vendor/three.module.js', threeModule],
    ['vendor/three.core.js', threeCore],
    ['vendor/addons/loaders/GLTFLoader.js', gltfLoader],
    ['vendor/addons/utils/BufferGeometryUtils.js', bufferGeometryUtils],
    ['vendor/addons/utils/SkeletonUtils.js', skeletonUtils],
    ['project.json', `${JSON.stringify(project, null, 2)}\n`],
    ['blueprints.json', `${JSON.stringify(graphIr, null, 2)}\n`],
    ['build-manifest.json', `${JSON.stringify({
      schema: 'LillyPlayerBundle/v2',
      projectId: project.id,
      revision: project.revision,
      engineVersion: project.engineVersion,
      levelChecksum: levelDesign?.checksum || null,
      moduleSourceHash: moduleBundle?.sourceHash || null,
      playerRuntimeHash: PLAYER_RUNTIME_HASH,
      moduleCount: moduleBundle?.modules?.length || 0,
      systemCount: moduleBundle?.systems?.length || 0,
      mechanicTestCount: moduleBundle?.tests?.length || 0,
      materialCount: moduleBundle?.materials?.length || 0,
      assetMetadataCount: moduleBundle?.assets?.length || 0,
      animationControllerCount: moduleBundle?.animations?.length || 0,
      terrainCount: moduleBundle?.terrains?.length || 0,
      generatedAt: new Date().toISOString(),
    }, null, 2)}\n`],
  ];
  for (const [relativePath, content] of files) {
    const targetPath = path.join(directory, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx' });
  }
  const packagedPaths = files.map(([relativePath]) => relativePath);
  if (projectDirectory) {
    const sourceRoot = path.resolve(projectDirectory);
    for (const asset of project.assets || []) {
      const relativePath = String(asset.uri || '').replace(/\\/g, '/');
      if (!relativePath.startsWith('assets/') || relativePath.includes('../')) continue;
      const sourcePath = path.resolve(sourceRoot, relativePath);
      if (!sourcePath.startsWith(`${sourceRoot}${path.sep}`)) continue;
      const targetPath = path.join(directory, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath, fsSync.constants.COPYFILE_EXCL);
      packagedPaths.push(relativePath);
    }
  }
  return Promise.all(packagedPaths.map(async (relativePath) => ({
    path: relativePath,
    ...await hashFile(path.join(directory, relativePath)),
  })));
}

module.exports = {
  PLAYER_JAVASCRIPT,
  GAMEPLAY_JAVASCRIPT,
  MODULE_SANDBOX_JAVASCRIPT,
  PLAYER_RUNTIME_HASH,
  buildIndexHtml,
  buildModuleSandboxHtml,
  writeImmutableBuild,
};
