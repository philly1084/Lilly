'use strict';

function source(path, value) {
  return {
    path,
    content: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    enabled: true,
  };
}

function dashModuleFiles() {
  return [
    source('modules/traversal/dash.module.json', {
      schema: 'LillyGameModule/v1',
      id: 'player-dash',
      name: 'Player Dash',
      version: '1.0.0',
      description: 'A testable traversal verb authored outside the editor.',
      dependencies: [],
      capabilities: ['input.read', 'physics.impulse', 'events.emit', 'hud.write'],
      systems: ['./dash.system.ts'],
      mechanics: ['./dash.mechanic.json'],
      prefabs: ['./dash-trail.prefab.json'],
      tests: ['./dash.spec.json'],
    }),
    source('modules/traversal/dash.mechanic.json', {
      schema: 'LillyMechanic/v1',
      id: 'player-dash',
      moduleId: 'player-dash',
      name: 'Player Dash',
      description: 'Impulse the controlled player along the Move axis.',
      systems: ['./dash.system.ts'],
      inputs: ['Dash', 'Move'],
      events: ['dash.performed', 'dash.hit'],
      components: [{ id: 'dash-state', fields: [{ name: 'cooldown', type: 'number', defaultValue: 0 }, { name: 'collisions', type: 'number', defaultValue: 0 }] }],
    }),
    source('modules/traversal/dash.system.ts', `import { defineSystem } from '@lilly/engine-runtime';

export default defineSystem({
  id: 'player-dash',
  state: { cooldown: 0, collisions: 0 },
  onFixedUpdate(ctx) {
    ctx.state.cooldown = Math.max(0, ctx.state.cooldown - ctx.delta);
    if (!ctx.input.button('Dash') || ctx.state.cooldown > 0) return;
    const move = ctx.input.axis2d('Move');
    ctx.physics.impulse(ctx.world.playerId, { x: move.x * 8, y: 0, z: move.y * 8 });
    ctx.events.emit('dash.performed', { entityId: ctx.world.playerId });
    ctx.hud.message('Dash performed');
    ctx.state.cooldown = 0.75;
  },
  onCollision(ctx) {
    if (ctx.collision.phase !== 'start') return;
    if (ctx.collision.entityA !== ctx.world.playerId && ctx.collision.entityB !== ctx.world.playerId) return;
    ctx.events.emit('dash.hit', { entityA: ctx.collision.entityA, entityB: ctx.collision.entityB });
    ctx.hud.message('Dash collision');
    ctx.state.collisions += 1;
  },
});`),
    source('modules/traversal/dash-trail.prefab.json', {
      schema: 'LillyPrefab/v1',
      id: 'dash-trail',
      moduleId: 'player-dash',
      name: 'Dash Trail',
      rootEntityId: 'trail',
      entities: [{
        schema: 'LillyEntity/v1',
        id: 'trail',
        name: 'Dash Trail',
        parentId: null,
        enabled: true,
        tags: ['fx', 'agent-authored'],
        components: [
          { type: 'Transform', enabled: true, data: { position: { x: 0, y: 0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.2, y: 0.2, z: 0.8 } } },
          { type: 'MeshRenderer', enabled: true, data: { geometry: 'box', material: { color: '#67e8f9', emissive: '#0891b2', emissiveIntensity: 0.8 } } },
        ],
      }],
    }),
    source('modules/traversal/dash.spec.json', {
      schema: 'LillyMechanicTest/v1',
      id: 'dash-fires-on-input',
      moduleId: 'player-dash',
      name: 'Dash fires once and starts cooldown',
      seed: 42,
      steps: [
        {
          event: 'fixed-update',
          delta: 1 / 60,
          input: { buttons: { Dash: true }, axes: { Move: { x: 1, y: 0 } } },
          world: { playerId: 'player', entities: [{ id: 'player', tags: ['player'] }] },
        },
        {
          event: 'collision',
          payload: { type: 'trigger', phase: 'start', entityA: 'player', entityB: 'pickup-1', tagsA: ['player'], tagsB: ['pickup'] },
          world: { playerId: 'player', entities: [{ id: 'player', tags: ['player'] }, { id: 'pickup-1', tags: ['pickup'] }] },
        },
      ],
      assertions: [
        { path: 'actions[0].type', operator: 'equals', value: 'physics.impulse' },
        { path: 'actions[1].type', operator: 'equals', value: 'events.emit' },
        { path: 'systems.player-dash.state.cooldown', operator: 'equals', value: 0.75 },
        { path: 'systems.player-dash.state.collisions', operator: 'equals', value: 1 },
        { path: 'actions[3].name', operator: 'equals', value: 'dash.hit' },
      ],
    }),
  ];
}

module.exports = { dashModuleFiles };
