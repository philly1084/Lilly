'use strict';

const plan = {
  schema: 'LillyGamePlan/v1', name: 'Sunseed Expedition', fantasy: 'Recover sunseeds from a woodland temple.',
  artDirection: 'Low-poly moss green stone and amber crystals, Y-up meters.', coreLoop: ['Explore connected rooms', 'Collect sunseeds', 'Reach the exit'],
  winCondition: 'Collect the seeds and reach the exit.', loseCondition: 'Hazards deplete health; restart from the checkpoint.',
  controls: ['WASD to move', 'Shift to dash'], acceptance: ['Move through the level, collect every seed and finish.', 'Dash twice rapidly; the second press should respect cooldown.'], deferred: [],
  levelPrompt: 'Three connected woodland rooms with pickups and an exit, no enemies.', environmentPrompt: 'Low rolling moss hills around the temple.', gameplayPrompt: 'An impulse dash on Shift with a cooldown.',
  assets: [{ id: 'seed', name: 'Sunseed', prompt: 'A small golden seed crystal.', placement: 'pickup' }, { id: 'arch', name: 'Temple arch', prompt: 'A small mossy temple arch.', placement: 'landmark' }],
};
const environment = { schema: 'LillyEnvironmentRecipe/v1', name: 'Sunseed Wood', seed: 'wood', terrain: { size: [96, 96], height: 2, color: '#527340', hills: [] }, sky: { color: '#a4d1e3', ambient: 1, sunColor: '#fff2d1', sunIntensity: 2 }, models: [{ id: 'rock', recipe: model('Woodland rock') }], scatter: [{ modelId: 'rock', count: 12, radius: 0.9, scale: [1, 1] }], placements: [] };
function model(name) { return { schema: 'LillyModelRecipe/v1', name, parts: [{ name: 'Crystal', shape: 'icosahedron', color: '#eeaa44', scale: [0.5, 0.8, 0.5] }] }; }
function gameplay() {
  const files = [
    { path: 'modules/game/dash.module.json', content: JSON.stringify({ schema: 'LillyGameModule/v1', id: 'game-dash', name: 'Dash', version: '1.0.0', dependencies: [], capabilities: ['input.read', 'physics.impulse'], systems: ['./dash.system.ts'], mechanics: [], prefabs: [], tests: ['./dash.spec.json'] }) },
    { path: 'modules/game/dash.system.ts', content: "import { defineSystem } from '@lilly/engine-runtime'; export default defineSystem({id:'game-dash',state:{cooldown:0},onFixedUpdate(ctx){ctx.state.cooldown=Math.max(0,ctx.state.cooldown-ctx.delta);if(ctx.input.button('Sprint')&&ctx.state.cooldown===0){const move=ctx.input.axis2d('Move');ctx.physics.impulse(ctx.world.playerId,{x:move.x*8,y:0,z:move.y*8});ctx.state.cooldown=1;}}});" },
    { path: 'modules/game/dash.spec.json', content: JSON.stringify({ schema: 'LillyMechanicTest/v1', id: 'dash-cooldown', moduleId: 'game-dash', name: 'Dash fires and cooldown prevents a second impulse', seed: 42, steps: Array.from({ length: 2 }, () => ({ event: 'fixed-update', delta: 0.25, input: { buttons: { Sprint: true }, axes: { Move: { x: 1, y: 0 } } }, world: { playerId: 'player', entities: [{ id: 'player', tags: ['player'] }] } })), assertions: [{ path: 'actions.length', operator: 'equals', value: 1 }, { path: 'actions[0].type', operator: 'equals', value: 'physics.impulse' }, { path: 'systems.game-dash.state.cooldown', operator: 'equals', value: 0.75 }] }) },
  ];
  const inputMap = require('../../../packages/lilly-engine/dist/core/src').createProjectFromTemplate({ id: 'fixture', template: 'expedition' }).inputMap;
  return { commands: [...files.map(file => ({ operation: 'file.upsert', target: {}, payload: { file } })), { operation: 'input.replace', target: {}, payload: { inputMap: [...inputMap, { action: 'Sprint', kind: 'button', keys: ['ShiftLeft'] }] } }] };
}
function response(prompt) {
  if (prompt.includes("You are Lilly's game director. Design")) return JSON.stringify(plan);
  if (prompt.includes('structurally valid starting point:')) return JSON.stringify({ recipe: JSON.parse(prompt.split('structurally valid starting point: ')[1].split('. Player request:')[0]) });
  if (prompt.includes('Author the original gameplay feature')) return JSON.stringify(gameplay());
  if (prompt.includes('LillyEnvironmentRecipe/v1')) return JSON.stringify(environment);
  return JSON.stringify(model(prompt.includes('temple arch') ? 'Temple arch' : 'Sunseed'));
}
module.exports = { plan, environment, model, gameplay, response };
