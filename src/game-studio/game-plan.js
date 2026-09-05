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
  stages: [
    { id: 'level', after: [] },
    { id: 'art', after: ['level'], parallel: true },
    { id: 'assembly', after: ['art'], singleWriter: true },
    { id: 'gameplay', after: ['assembly'] },
    { id: 'verify', after: ['gameplay'], requires: ['compiled modules', 'passing mechanic tests', 'passing playtest', 'immutable build'] },
  ],
  tools: [
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
    return { id, name: string(asset.name, 'Asset name', 100), prompt: string(asset.prompt, 'Asset prompt'), placement: ['landmark', 'pickup', 'player'].includes(asset.placement) ? asset.placement : 'landmark' };
  });
  return {
    schema: PLAN_SCHEMA,
    name: string(input.name, 'Game name', 100),
    fantasy: string(input.fantasy, 'Player fantasy'),
    artDirection: string(input.artDirection, 'Art direction'),
    coreLoop: list(input.coreLoop, 'Core loop'),
    winCondition: string(input.winCondition, 'Win condition', 500),
    loseCondition: string(input.loseCondition, 'Loss and restart', 500),
    controls: list(input.controls, 'Controls'),
    acceptance: list(input.acceptance, 'Playtest checklist'),
    deferred: Array.isArray(input.deferred) ? input.deferred.slice(0, 12).map(entry => string(entry, 'Deferred feature', 500)) : [],
    levelPrompt: string(input.levelPrompt, 'Level brief'),
    environmentPrompt: string(input.environmentPrompt, 'Environment brief'),
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
  return { models, concurrency };
}
function designPrompt(brief) {
  return `You are Lilly's game director. Design a complete, small, playable browser game from this brief. Return JSON only using ${PLAN_SCHEMA}. Build a coherent player fantasy, core loop, win/loss/restart, controls, art bible, level brief, environment brief, and one original gameplay mechanic with deterministic tests. The level tool provides connected third-person rooms, pickups, checkpoints, hazards, simple guardian combat and an exit. Other mechanics are authored in capability-sandboxed TypeScript. Stay within actual capabilities: ${JSON.stringify(CAPABILITIES)}. Explicitly put unsupported requested features in deferred, never pretend they are implemented. Keep the game achievable in one playable level. Environment is outdoor scenery around the level. Choose 1–4 distinct original hero props; model workers run independently with the same art direction. No model/provider names in the plan. Required shape: {schema,name,fantasy,artDirection,coreLoop:[string],winCondition,loseCondition,controls:[string],acceptance:[specific human playtest steps],deferred:[string],levelPrompt,environmentPrompt,gameplayPrompt,assets:[{id:lowercase-slug,name,prompt,placement:landmark|pickup|player}]}. Describe proportions in meters, Y-up and consistent colors. Keep individual prompts under 2000 characters. User brief: ${JSON.stringify(brief)}`;
}

module.exports = { PLAN_SCHEMA, CAPABILITIES, validatePlan, routing, designPrompt, invalid };
