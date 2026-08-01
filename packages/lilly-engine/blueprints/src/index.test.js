const { BLUEPRINT_SCHEMA, createArenaProject } = require('../../dist/core/src');
const { GRAPH_IR_SCHEMA, canConnectPins, compileBlueprint, validateBlueprint } = require('../../dist/blueprints/src');

describe('Lilly Blueprint compiler', () => {
  test('compiles the canary win condition to validated IR', () => {
    const graph = createArenaProject({ id: 'blueprint' }).blueprints[0];
    expect(validateBlueprint(graph)).toEqual([]);
    const ir = compileBlueprint(graph);
    expect(ir.schema).toBe(GRAPH_IR_SCHEMA);
    expect(ir.entrypoints).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'custom' })]));
    expect(ir.instructions).toHaveLength(graph.nodes.length);
  });

  test('typed pins reject invalid data connections', () => {
    expect(canConnectPins(
      { id: 'out', name: 'Out', kind: 'data', direction: 'output', dataType: 'number' },
      { id: 'in', name: 'In', kind: 'data', direction: 'input', dataType: 'vector3' },
    )).toBe(false);
  });

  test('rejects implicit execution cycles', () => {
    const graph = {
      schema: BLUEPRINT_SCHEMA,
      id: 'cycle',
      name: 'Cycle',
      variables: [],
      nodes: [
        { id: 'a', type: 'flow.gate', position: { x: 0, y: 0 }, pins: [] },
        { id: 'b', type: 'flow.gate', position: { x: 100, y: 0 }, pins: [] },
      ],
      edges: [
        { id: 'a-b', sourceNodeId: 'a', sourcePinId: 'exec-out', targetNodeId: 'b', targetPinId: 'exec-in' },
        { id: 'b-a', sourceNodeId: 'b', sourcePinId: 'exec-out', targetNodeId: 'a', targetPinId: 'exec-in' },
      ],
    };
    expect(validateBlueprint(graph)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'IMPLICIT_EXECUTION_CYCLE' })]));
    expect(() => compileBlueprint(graph)).toThrow(/cycle/i);
  });

  test('allows cycles across explicit delay boundaries', () => {
    const graph = {
      schema: BLUEPRINT_SCHEMA,
      id: 'bounded-cycle',
      name: 'Bounded Cycle',
      variables: [],
      nodes: [
        { id: 'gate', type: 'flow.gate', position: { x: 0, y: 0 }, pins: [] },
        { id: 'delay', type: 'flow.delay', position: { x: 100, y: 0 }, pins: [] },
      ],
      edges: [
        { id: 'g-d', sourceNodeId: 'gate', sourcePinId: 'exec-out', targetNodeId: 'delay', targetPinId: 'exec-in' },
        { id: 'd-g', sourceNodeId: 'delay', sourcePinId: 'exec-out', targetNodeId: 'gate', targetPinId: 'exec-in' },
      ],
    };
    expect(validateBlueprint(graph)).toEqual([]);
  });
});
