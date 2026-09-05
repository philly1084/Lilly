'use strict';

// Deterministic author for integration/browser QA. Never used as a production AI fallback.
const { createProjectFromTemplate, COMPONENT_DEFINITIONS } = require('../../../packages/lilly-engine/dist/core/src');
const { model } = require('./game-production');
const plan = {
  schema: 'LillyGamePlan/v1', foundation: 'authored', name: 'Prism Sequence',
  fantasy: 'Restore a prism by stepping on three colored plates in the correct order.',
  artDirection: 'A midnight blue courtyard, cyan explorer, amber, pink and green plates, luminous gold prism; Y-up meters.',
  coreLoop: ['Read the color sequence', 'Walk onto amber, pink, then green', 'Restore the prism before time runs out'],
  winCondition: 'Trigger amber, pink, then green in order.', loseCondition: 'A wrong plate or the 60 second timer ends the attempt. R restarts.',
  controls: ['WASD or touch stick to move', 'R or Restart to retry'],
  acceptance: ['Walk straight ahead across amber, pink, green and see Prism restored.', 'Walk around amber and touch pink first; see Wrong plate.', 'Restart after winning or losing and complete the sequence again.'], deferred: [],
  scenePrompt: 'A single open courtyard with player at (0,0.72,7), amber plate-1 at z=3, pink plate-2 at z=0, green plate-3 at z=-3, each a sensor. Camera above and behind the player. Prism placeholder beacon at (4,1,-3).',
  levelPrompt: 'An open courtyard, not an expedition.', environmentPrompt: null,
  gameplayPrompt: 'Implement ordered trigger plates 1,2,3, win, wrong-order loss, 60 second timeout, reset and HUD instructions. Ignore repeated or non-player collisions.',
  assets: [{ id: 'beacon', name: 'Prism', prompt: 'A small luminous gold prism, one meter tall.', placement: 'landmark', targetEntityId: 'beacon' }],
};
const inputMap = [{ action: 'Move', kind: 'axis2d', keys: ['KeyW', 'KeyS', 'KeyA', 'KeyD'] }, { action: 'Reset', kind: 'button', keys: ['KeyR'] }];
function component(type, data) { return { type, enabled: true, data: { ...COMPONENT_DEFINITIONS[type].defaults, ...data } }; }
function entity(id, name, position, scale, color, tags, extra = []) {
  return { schema: 'LillyEntity/v1', id, name, parentId: 'world', enabled: true, tags, components: [component('Transform', { position, scale }), component('MeshRenderer', { geometry: 'box', material: { color, roughness: 0.75, metalness: 0.15 } }), ...extra] };
}
function scene() {
  const syntax = createProjectFromTemplate({ id: 'syntax', template: 'third-person-explorer' }).scenes[0].entities;
  const player = structuredClone(syntax.find(e => e.id === 'player'));
  player.name = 'Prism Keeper'; player.components.find(c => c.type === 'Transform').data.position = { x: 0, y: 0.72, z: 7 };
  const camera = structuredClone(syntax.find(e => e.id === 'camera'));
  Object.assign(camera.components.find(c => c.type === 'Camera').data, { followOffset: { x: 0, y: 12, z: 9 }, lookAtHeight: 0, fov: 58 });
  const floor = entity('courtyard', 'Prism Court', { x: 0, y: -0.2, z: 0 }, { x: 22, y: 0.4, z: 22 }, '#243b59', ['ground'], [component('Collider', { size: { x: 22, y: 0.4, z: 22 } })]);
  const plates = ['#ffc857', '#ff709e', '#72e8aa'].map((color, i) => entity(`plate-${i + 1}`, ['Amber first', 'Pink second', 'Green third'][i], { x: 0, y: 0.1, z: 3 - i * 3 }, { x: 2, y: 0.2, z: 2 }, color, ['plate'], [component('Collider', { size: { x: 2, y: 2, z: 2 }, sensor: true })]));
  const beacon = entity('beacon', 'Prism placeholder', { x: 4, y: 1, z: -3 }, { x: 1, y: 1, z: 1 }, '#ffcc66', ['prism']);
  return { commands: [
    { operation: 'scene.rename', target: { sceneId: 'main' }, payload: { name: 'Prism Courtyard' } },
    ...[floor, player, camera, syntax.find(e => e.id === 'sun'), ...plates, beacon].map(e => ({ operation: 'entity.create', target: { sceneId: 'main' }, payload: { entity: e } })),
    { operation: 'input.replace', target: {}, payload: { inputMap } },
  ] };
}
function gameplay() {
  const source = `import { defineSystem } from '@lilly/engine-runtime';
export default defineSystem({
  id: 'prism-rules', state: { progress: 0, remaining: 60, status: 'playing', lastSecond: 60 },
  onStart(ctx) { ctx.hud.message('Amber → pink → green. WASD / touch to move. R to restart. 60 seconds.', { status: 'Prism Sequence' }); },
  onFixedUpdate(ctx) {
    if (ctx.input.button('Reset')) {
      ctx.state.progress = 0; ctx.state.remaining = 60; ctx.state.lastSecond = 60; ctx.state.status = 'playing';
      ctx.entities.patch(ctx.world.playerId, 'Transform', { position: { x: 0, y: 0.72, z: 7 } });
      ctx.hud.message('Try again: amber → pink → green. 60 seconds.', { status: 'Prism Sequence' }); return;
    }
    if (ctx.state.status !== 'playing') return;
    ctx.state.remaining = Math.max(0, ctx.state.remaining - ctx.delta);
    if (ctx.state.remaining === 0) { ctx.state.status = 'lost'; ctx.hud.message('Time ran out. Press R or Restart.', { status: 'Time up', state: 'danger' }); }
    else if (Math.ceil(ctx.state.remaining) !== ctx.state.lastSecond) {
      ctx.state.lastSecond = Math.ceil(ctx.state.remaining);
      ctx.hud.message('Amber → pink → green · ' + ctx.state.progress + '/3 · ' + ctx.state.lastSecond + 's', { status: 'Prism Sequence' });
    }
  },
  onCollision(ctx) {
    if (ctx.state.status !== 'playing' || ctx.collision.phase !== 'start') return;
    const other = ctx.collision.entityA === ctx.world.playerId ? ctx.collision.entityB : ctx.collision.entityB === ctx.world.playerId ? ctx.collision.entityA : '';
    const number = ['plate-1', 'plate-2', 'plate-3'].indexOf(other) + 1;
    if (!number || number <= ctx.state.progress) return;
    if (number !== ctx.state.progress + 1) { ctx.state.status = 'lost'; ctx.hud.message('Wrong plate. Amber → pink → green. Press R or Restart.', { status: 'Sequence broken', state: 'danger' }); return; }
    ctx.state.progress = number;
    if (number === 3) { ctx.state.status = 'won'; ctx.hud.message('Prism restored! Press R or Restart to play again.', { status: 'You win', state: 'success' }); }
    else ctx.hud.message('Correct! ' + number + '/3 plates. Keep going.', { status: 'Prism Sequence', state: 'success' });
  },
});`;
  const collision = number => ({ event: 'collision', payload: { type: 'trigger', phase: 'start', entityA: 'player', entityB: `plate-${number}`, tagsA: ['player'], tagsB: ['plate'] }, world: { playerId: 'player', entities: [] } });
  const assertion = (field, value) => ({ path: `systems.prism-rules.state.${field}`, operator: 'equals', value });
  const specs = [
    { id: 'prism-win', steps: [collision(1), collision(1), collision(2), collision(3)], assertions: [assertion('status', 'won'), assertion('progress', 3), { path: 'actions[2].text', operator: 'equals', value: 'Prism restored! Press R or Restart to play again.' }] },
    { id: 'prism-loss', steps: [collision(2), collision(1), collision(3)], assertions: [assertion('status', 'lost'), assertion('progress', 0), { path: 'actions.length', operator: 'equals', value: 1 }] },
    { id: 'prism-reset', steps: [collision(2), { event: 'fixed-update', input: { buttons: { Reset: true } } }, collision(1), collision(2), collision(3)], assertions: [assertion('status', 'won'), assertion('remaining', 60), { path: 'actions[1].type', operator: 'equals', value: 'entity.patch' }, { path: 'actions[1].values.position.z', operator: 'equals', value: 7 }] },
    { id: 'prism-timeout', steps: [{ event: 'fixed-update', delta: 61 }], assertions: [assertion('status', 'lost'), assertion('remaining', 0)] },
  ];
  const files = [
    { path: 'modules/game/prism.module.json', content: JSON.stringify({ schema: 'LillyGameModule/v1', id: 'prism-game', name: 'Prism Sequence', version: '1.0.0', dependencies: [], capabilities: ['input.read', 'hud.write', 'entity.write'], systems: ['./prism.system.ts'], mechanics: [], prefabs: [], tests: specs.map(s => `./${s.id}.spec.json`) }) },
    { path: 'modules/game/prism.system.ts', content: source },
    ...specs.map(s => ({ path: `modules/game/${s.id}.spec.json`, content: JSON.stringify({ schema: 'LillyMechanicTest/v1', moduleId: 'prism-game', name: s.id, seed: 42, ...s }) })),
  ];
  return { commands: files.map(file => ({ operation: 'file.upsert', target: {}, payload: { file } })), coverage: { win: 'prism-win', loss: 'prism-loss', reset: 'prism-reset' } };
}
function response(prompt) {
  if (prompt.includes("You are Lilly's game director. Design")) return JSON.stringify(plan);
  if (prompt.includes("You are Lilly's original scene builder")) return JSON.stringify(scene());
  if (prompt.includes('Author the original gameplay feature')) return JSON.stringify(gameplay());
  return JSON.stringify(model('Prism'));
}
module.exports = { plan, scene, gameplay, response };
