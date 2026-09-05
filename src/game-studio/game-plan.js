'use strict';

const PLAN_SCHEMA = 'LillyGamePlan/v1';
const ROLES = ['director', 'level', 'environment', 'asset', 'gameplay'];
// Stable tool contracts, independent of provider names or model generations.
const CAPABILITIES = {
  schema: 'LillyProductionCapabilities/v1',
  planSchema: PLAN_SCHEMA,
  roles: ROLES,
  maxConcurrency: 4,
  maxAssets: 6,
  foundations: ['authored', 'expedition'],
  stages: [
    { id: 'level', after: [] },
    { id: 'art', after: ['level'], parallel: true },
    { id: 'assembly', after: ['art'], singleWriter: true },
    { id: 'gameplay', after: ['assembly'] },
    { id: 'verify', after: ['gameplay'], requires: ['compiled modules', 'passing mechanic tests', 'passing playtest', 'immutable build'] },
  ],
  tools: [
    { id: 'scene', output: 'LillyCommand/v1[]', writes: 'original scenes, entities, camera, player and controls from a blank project' },
    { id: 'level', output: 'LillyLevelRecipe/v1', writes: 'scene topology and core objective' },
    { id: 'environment', output: 'LillyEnvironmentRecipe/v1', writes: 'terrain, atmosphere and reusable scenery GLBs' },
    { id: 'asset', output: 'LillyModelRecipe/v1', writes: 'editable model source and GLB' },
    { id: 'gameplay', output: 'LillyCommand/v1[]', writes: 'sandboxed modules, inputs and deterministic tests' },
  ],
  limits: ['Browser games', 'Stylized static generated models; import rigged GLBs separately', 'No generated audio, networking or arbitrary external packages', 'Automated validation does not replace human playtesting'],
};

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 422, code: 'GAME_PLAN_INVALID' });
}
function string(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${label} needs 1–${max} characters.`);
  return value.trim();
}
function list(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 12) throw invalid(`${label} needs 1–12 entries.`);
  return value.map(entry => string(entry, label, 500));
}
function validatePlan(input) {
  if (!input || input.schema !== PLAN_SCHEMA) throw invalid(`Use ${PLAN_SCHEMA}.`);
  if (!Array.isArray(input.assets) || input.assets.length > CAPABILITIES.maxAssets) throw invalid('Choose up to six original assets.');
  const ids = new Set();
  const assets = input.assets.map(asset => {
    const id = string(asset.id, 'Asset id', 48);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || ids.has(id)) throw invalid('Asset ids must be unique lowercase slugs.');
    ids.add(id);
    const targetEntityId = asset.targetEntityId ? string(asset.targetEntityId, 'Asset target entity', 100) : null;
    return { id, name: string(asset.name, 'Asset name', 100), prompt: string(asset.prompt, 'Asset prompt'), placement: ['landmark', 'pickup', 'player'].includes(asset.placement) ? asset.placement : 'landmark', ...(targetEntityId ? { targetEntityId } : {}) };
  });
  const foundation = input.foundation || 'expedition';
  if (!CAPABILITIES.foundations.includes(foundation)) throw invalid('Choose authored or expedition as the game foundation.');
  return {
    schema: PLAN_SCHEMA,
    foundation,
    name: string(input.name, 'Game name', 100),
    fantasy: string(input.fantasy, 'Player fantasy'),
    artDirection: string(input.artDirection, 'Art direction'),
    coreLoop: list(input.coreLoop, 'Core loop'),
    winCondition: string(input.winCondition, 'Win condition', 500),
    loseCondition: string(input.loseCondition, 'Loss and restart', 500),
    controls: list(input.controls, 'Controls'),
    acceptance: list(input.acceptance, 'Playtest checklist'),
    deferred: Array.isArray(input.deferred) ? input.deferred.slice(0, 12).map(entry => string(entry, 'Deferred feature', 500)) : [],
    levelPrompt: string(input.levelPrompt || input.scenePrompt, 'Level brief'),
    ...(foundation === 'authored' ? { scenePrompt: string(input.scenePrompt || input.levelPrompt, 'Original scene brief') } : {}),
    environmentPrompt: input.environmentPrompt === null ? null : string(input.environmentPrompt, 'Environment brief'),
    gameplayPrompt: string(input.gameplayPrompt, 'Original gameplay brief'),
    assets,
  };
}
function routing(input = {}) {
  const models = {};
  for (const role of ROLES) {
    const value = input.models?.[role] ?? input.model ?? '';
    if (typeof value !== 'string' || value.length > 160) throw invalid('Model ids must be strings up to 160 characters.');
    models[role] = value;
  }
  const concurrency = Number(input.concurrency ?? 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > CAPABILITIES.maxConcurrency) throw invalid('Choose 1–4 parallel workers.');
  const taskModels = {};
  if (input.taskModels !== undefined && (!input.taskModels || typeof input.taskModels !== 'object' || Array.isArray(input.taskModels))) throw invalid('Task models must map task ids to connected model ids.');
  for (const [id, model] of Object.entries(input.taskModels || {})) {
    if (!/^(level|environment|gameplay|asset-[a-z][a-z0-9-]{0,47})$/.test(id) || typeof model !== 'string' || model.length > 160) throw invalid('Task models must name level, environment, gameplay or a planned asset task.');
    taskModels[id] = model;
  }
  if (Object.keys(taskModels).length > 9) throw invalid('There can be at most nine task model overrides.');
  return { models, taskModels, concurrency };
}
function designPrompt(brief) {
  return `You are Lilly's game director. Design a complete playable browser game from this brief, preserving the requested genre and core experience. Return JSON only using ${PLAN_SCHEMA}. Build a coherent player fantasy, core loop, win/loss/restart, controls, art bible and gameplay systems with deterministic tests. Choose foundation authored for original games: a scene builder starts from an EMPTY project, creates the actual camera, player, world geometry and input map; a gameplay programmer implements the full rules, HUD, win/loss/reset and progression in capability-sandboxed TypeScript. Supply scenePrompt with concrete spatial layout, stable entity ids/tags, camera and controller requirements. Do not convert racing, puzzle, exploration or other ideas into a collect-and-exit game. Choose foundation expedition only when the requested game fits connected third-person rooms, pickups, checkpoints, hazards, guardian combat and an exit; levelPrompt controls its validated room generator. environmentPrompt is optional outdoor scenery around the world; set null for indoor/abstract games. Stay within actual capabilities: ${JSON.stringify(CAPABILITIES)}. Explicitly put unsupported requested features in deferred, never pretend they are implemented. Choose up to six independent model jobs with shared art direction; assets may use targetEntityId to replace a specific scene placeholder mesh, which scenePrompt must name. No model/provider names in the plan. Required shape: {schema,foundation:authored|expedition,name,fantasy,artDirection,coreLoop:[string],winCondition,loseCondition,controls:[string],acceptance:[specific human playtest steps],deferred:[string],levelPrompt,scenePrompt,environmentPrompt:string|null,gameplayPrompt,assets:[{id:lowercase-slug,name,prompt,placement:landmark|pickup|player,targetEntityId?:string}]}. Describe proportions in meters, Y-up and consistent colors. Keep individual prompts under 2000 characters. User brief: ${JSON.stringify(brief)}`;
}

module.exports = { PLAN_SCHEMA, CAPABILITIES, validatePlan, routing, designPrompt, invalid };
