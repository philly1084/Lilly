'use strict';

const { createProceduralProject } = require('../../dist/core/src');
const { GameplaySimulation, GAMEPLAY_SAVE_SCHEMA } = require('../../dist/gameplay/src');

function combatProject() {
  return createProceduralProject({
    id: 'gameplay-test',
    prompt: 'A compact neon arena with one combat encounter and one guardian',
    seed: 'gameplay-seed',
  });
}

function stepIntoEncounter(simulation, project) {
  const design = project.generatedLevels[0];
  const encounter = design.encounters[0];
  const room = design.rooms.find((entry) => entry.id === encounter.roomId);
  simulation.step(1 / 60, { playerPosition: room.position });
  return { design, encounter, room };
}

describe('GameplaySimulation', () => {
  test('activates a room encounter and closes only its stable gates', () => {
    const project = combatProject();
    const simulation = new GameplaySimulation(project);
    const { encounter } = stepIntoEncounter(simulation, project);
    const state = simulation.getState();
    expect(state.activeEncounterId).toBe(encounter.id);
    expect(encounter.gateIds.every((id) => state.gates[id] === true)).toBe(true);
    expect(simulation.drainEvents()).toContainEqual(expect.objectContaining({ type: 'encounter-started', encounterId: encounter.id }));
  });

  test('replays combat deterministically and unlocks a checkpoint', () => {
    const project = combatProject();
    const run = () => {
      const simulation = new GameplaySimulation(project);
      const { encounter, room } = stepIntoEncounter(simulation, project);
      for (let frame = 0; frame < 600 && !simulation.getState().encounters[0].cleared; frame += 1) {
        simulation.step(1 / 60, { playerPosition: room.position, attackPressed: frame % 28 === 0 });
      }
      const state = simulation.getState();
      expect(state.encounters[0].cleared).toBe(true);
      expect(state.checkpoint.id).toBe(encounter.checkpointId);
      expect(encounter.gateIds.every((id) => state.gates[id] === false)).toBe(true);
      return state;
    };
    expect(run()).toEqual(run());
  });

  test('death restores the latest checkpoint and resets an uncleared encounter', () => {
    const project = combatProject();
    const simulation = new GameplaySimulation(project);
    const { encounter, room } = stepIntoEncounter(simulation, project);
    simulation.damagePlayerFromHazard(999);
    const state = simulation.getState();
    expect(state.player.health).toBe(state.player.maxHealth);
    expect(state.activeEncounterId).toBeNull();
    expect(state.enemies.filter((enemy) => enemy.encounterId === encounter.id).every((enemy) => enemy.health === enemy.maxHealth)).toBe(true);
    expect(simulation.drainEvents()).toContainEqual(expect.objectContaining({ type: 'player-respawned', position: project.generatedLevels[0].spawn.position }));
  });

  test('serializes cleared encounters with stable entity ids', () => {
    const project = combatProject();
    const first = new GameplaySimulation(project);
    const { room } = stepIntoEncounter(first, project);
    for (let frame = 0; frame < 600 && !first.getState().encounters[0].cleared; frame += 1) {
      first.step(1 / 60, { playerPosition: room.position, attackPressed: frame % 28 === 0 });
    }
    const saved = first.serialize();
    expect(saved.schema).toBe(GAMEPLAY_SAVE_SCHEMA);
    const restored = new GameplaySimulation(project);
    expect(restored.restore(saved)).toBe(true);
    expect(restored.serialize()).toEqual(saved);
  });
});
