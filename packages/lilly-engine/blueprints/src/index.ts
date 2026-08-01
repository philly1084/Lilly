import type {
  LillyBlueprint,
  LillyBlueprintEdge,
  LillyBlueprintNode,
  LillyBlueprintPin,
  ValidationIssue,
} from '../../core/src';

export const GRAPH_IR_SCHEMA = 'LillyGraphIR/v1' as const;

export interface LillyGraphIRInstruction {
  id: string;
  opcode: string;
  args: Record<string, unknown>;
  next: Record<string, string[]>;
}

export interface LillyGraphIR {
  schema: typeof GRAPH_IR_SCHEMA;
  graphId: string;
  graphName: string;
  variables: LillyBlueprint['variables'];
  entrypoints: Array<{ event: string; instructionId: string }>;
  instructions: LillyGraphIRInstruction[];
}

type PinDefinition = Omit<LillyBlueprintPin, 'id'> & { id: string };

export interface BlueprintNodeDefinition {
  type: string;
  family: 'events' | 'flow' | 'data' | 'entity' | 'transform-physics' | 'presentation' | 'utility';
  label: string;
  pins: PinDefinition[];
  boundary?: boolean;
}

const execIn: PinDefinition = { id: 'exec-in', name: 'In', kind: 'exec', direction: 'input' };
const execOut: PinDefinition = { id: 'exec-out', name: 'Then', kind: 'exec', direction: 'output' };

export const NODE_REGISTRY: Record<string, BlueprintNodeDefinition> = Object.fromEntries([
  ['event.start', 'events', 'Start', [execOut], true],
  ['event.update', 'events', 'Update', [execOut], true],
  ['event.fixed-update', 'events', 'Fixed Update', [execOut], true],
  ['event.input', 'events', 'Input Action', [execOut], true],
  ['event.collision', 'events', 'Collision', [execOut], true],
  ['event.trigger', 'events', 'Trigger', [execOut], true],
  ['event.timer', 'events', 'Timer', [execOut], true],
  ['event.custom', 'events', 'Custom Event', [execOut], true],
  ['flow.branch', 'flow', 'Branch', [execIn, { ...execOut, id: 'true', name: 'True' }, { ...execOut, id: 'false', name: 'False' }, { id: 'condition', name: 'Condition', kind: 'data', direction: 'input', dataType: 'boolean', required: true }]],
  ['flow.sequence', 'flow', 'Sequence', [execIn, { ...execOut, id: 'then-0', name: 'Then 0' }, { ...execOut, id: 'then-1', name: 'Then 1' }]],
  ['flow.gate', 'flow', 'Gate', [execIn, execOut]],
  ['flow.once', 'flow', 'Once', [execIn, execOut]],
  ['flow.delay', 'flow', 'Delay', [execIn, execOut], true],
  ['flow.loop', 'flow', 'Loop', [execIn, { ...execOut, id: 'body', name: 'Body' }, { ...execOut, id: 'completed', name: 'Completed' }], true],
  ['data.boolean', 'data', 'Boolean', [{ id: 'value', name: 'Value', kind: 'data', direction: 'output', dataType: 'boolean' }]],
  ['data.number', 'data', 'Number', [{ id: 'value', name: 'Value', kind: 'data', direction: 'output', dataType: 'number' }]],
  ['data.string', 'data', 'String', [{ id: 'value', name: 'Value', kind: 'data', direction: 'output', dataType: 'string' }]],
  ['data.vector2', 'data', 'Vector2', [{ id: 'value', name: 'Value', kind: 'data', direction: 'output', dataType: 'vector2' }]],
  ['data.vector3', 'data', 'Vector3', [{ id: 'value', name: 'Value', kind: 'data', direction: 'output', dataType: 'vector3' }]],
  ['variable.get', 'data', 'Get Variable', [{ id: 'value', name: 'Value', kind: 'data', direction: 'output', dataType: 'any' }]],
  ['variable.set', 'data', 'Set Variable', [execIn, execOut, { id: 'value', name: 'Value', kind: 'data', direction: 'input', dataType: 'any' }]],
  ['variable.add', 'data', 'Add Variable', [execIn, execOut, { id: 'amount', name: 'Amount', kind: 'data', direction: 'input', dataType: 'number' }]],
  ['entity.spawn', 'entity', 'Spawn Entity', [execIn, execOut, { id: 'entity', name: 'Entity', kind: 'data', direction: 'output', dataType: 'entity' }]],
  ['entity.destroy', 'entity', 'Destroy Entity', [execIn, execOut, { id: 'entity', name: 'Entity', kind: 'data', direction: 'input', dataType: 'entity' }]],
  ['entity.enable', 'entity', 'Set Enabled', [execIn, execOut, { id: 'entity', name: 'Entity', kind: 'data', direction: 'input', dataType: 'entity' }]],
  ['entity.find-tag', 'entity', 'Find by Tag', [{ id: 'entity', name: 'Entity', kind: 'data', direction: 'output', dataType: 'entity' }]],
  ['entity.get-component', 'entity', 'Get Component', [{ id: 'entity', name: 'Entity', kind: 'data', direction: 'input', dataType: 'entity' }, { id: 'value', name: 'Component', kind: 'data', direction: 'output', dataType: 'any' }]],
  ['entity.set-component', 'entity', 'Set Component', [execIn, execOut, { id: 'entity', name: 'Entity', kind: 'data', direction: 'input', dataType: 'entity' }, { id: 'value', name: 'Component', kind: 'data', direction: 'input', dataType: 'any' }]],
  ['transform.move', 'transform-physics', 'Move', [execIn, execOut, { id: 'delta', name: 'Delta', kind: 'data', direction: 'input', dataType: 'vector3' }]],
  ['transform.rotate', 'transform-physics', 'Rotate', [execIn, execOut, { id: 'delta', name: 'Delta', kind: 'data', direction: 'input', dataType: 'vector3' }]],
  ['physics.force', 'transform-physics', 'Add Force', [execIn, execOut, { id: 'force', name: 'Force', kind: 'data', direction: 'input', dataType: 'vector3' }]],
  ['physics.impulse', 'transform-physics', 'Add Impulse', [execIn, execOut, { id: 'impulse', name: 'Impulse', kind: 'data', direction: 'input', dataType: 'vector3' }]],
  ['physics.raycast', 'transform-physics', 'Raycast', [execIn, execOut, { id: 'hit', name: 'Hit Entity', kind: 'data', direction: 'output', dataType: 'entity' }]],
  ['presentation.animation', 'presentation', 'Play Animation', [execIn, execOut]],
  ['presentation.audio', 'presentation', 'Play Audio', [execIn, execOut]],
  ['presentation.particles', 'presentation', 'Emit Particles', [execIn, execOut]],
  ['presentation.camera', 'presentation', 'Set Camera', [execIn, execOut]],
  ['presentation.hud-message', 'presentation', 'HUD Message', [execIn, execOut]],
  ['utility.math', 'utility', 'Math', [{ id: 'a', name: 'A', kind: 'data', direction: 'input', dataType: 'number' }, { id: 'b', name: 'B', kind: 'data', direction: 'input', dataType: 'number' }, { id: 'value', name: 'Value', kind: 'data', direction: 'output', dataType: 'number' }]],
  ['utility.compare', 'utility', 'Compare', [{ id: 'a', name: 'A', kind: 'data', direction: 'input', dataType: 'any' }, { id: 'b', name: 'B', kind: 'data', direction: 'input', dataType: 'any' }, { id: 'value', name: 'Result', kind: 'data', direction: 'output', dataType: 'boolean' }]],
  ['utility.random', 'utility', 'Random', [{ id: 'value', name: 'Value', kind: 'data', direction: 'output', dataType: 'number' }]],
  ['utility.debug-log', 'utility', 'Debug Log', [execIn, execOut, { id: 'value', name: 'Value', kind: 'data', direction: 'input', dataType: 'any' }]],
].map(([type, family, label, pins, boundary]) => [type, { type, family, label, pins, boundary } as BlueprintNodeDefinition]));

function findPin(node: LillyBlueprintNode, pinId: string) {
  return node.pins.find((pin) => pin.id === pinId)
    || NODE_REGISTRY[node.type]?.pins.find((pin) => pin.id === pinId)
    || null;
}

export function canConnectPins(source: LillyBlueprintPin | null, target: LillyBlueprintPin | null) {
  if (!source || !target || source.direction !== 'output' || target.direction !== 'input') return false;
  if (source.kind !== target.kind) return false;
  if (source.kind === 'exec') return true;
  return source.dataType === target.dataType || source.dataType === 'any' || target.dataType === 'any';
}

function findCycle(graph: LillyBlueprint, validEdges: LillyBlueprintEdge[]) {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>();
  validEdges.forEach((edge) => {
    const source = nodeMap.get(edge.sourceNodeId);
    const target = nodeMap.get(edge.targetNodeId);
    const sourcePin = source && findPin(source, edge.sourcePinId);
    if (!source || !target || sourcePin?.kind !== 'exec' || NODE_REGISTRY[source.type]?.boundary || NODE_REGISTRY[target.type]?.boundary) return;
    adjacency.set(source.id, [...(adjacency.get(source.id) || []), target.id]);
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const dfs = (id: string): string[] | null => {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id); stack.push(id);
    for (const next of adjacency.get(id) || []) {
      const cycle = dfs(next);
      if (cycle) return cycle;
    }
    stack.pop(); visiting.delete(id); visited.add(id);
    return null;
  };
  for (const node of graph.nodes) {
    const cycle = dfs(node.id);
    if (cycle) return cycle;
  }
  return null;
}

export function validateBlueprint(graph: LillyBlueprint): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeMap = new Map<string, LillyBlueprintNode>();
  graph.nodes.forEach((node, index) => {
    if (nodeMap.has(node.id)) issues.push({ code: 'DUPLICATE_NODE_ID', message: `Duplicate node id ${node.id}`, path: `nodes[${index}].id`, severity: 'error' });
    nodeMap.set(node.id, node);
    if (!NODE_REGISTRY[node.type]) issues.push({ code: 'UNKNOWN_NODE_TYPE', message: `Unknown node type ${node.type}`, path: `nodes[${index}].type`, severity: 'error' });
  });
  const validEdges: LillyBlueprintEdge[] = [];
  const inputConnections = new Set<string>();
  graph.edges.forEach((edge, index) => {
    const source = nodeMap.get(edge.sourceNodeId);
    const target = nodeMap.get(edge.targetNodeId);
    const sourcePin = source ? findPin(source, edge.sourcePinId) : null;
    const targetPin = target ? findPin(target, edge.targetPinId) : null;
    if (!source || !target) {
      issues.push({ code: 'EDGE_NODE_MISSING', message: 'Blueprint edge references a missing node', path: `edges[${index}]`, severity: 'error' });
      return;
    }
    if (!canConnectPins(sourcePin, targetPin)) {
      issues.push({ code: 'PIN_TYPE_MISMATCH', message: `Cannot connect ${source.type}.${edge.sourcePinId} to ${target.type}.${edge.targetPinId}`, path: `edges[${index}]`, severity: 'error' });
      return;
    }
    const inputKey = `${edge.targetNodeId}:${edge.targetPinId}`;
    if (targetPin?.kind === 'data' && inputConnections.has(inputKey)) {
      issues.push({ code: 'MULTIPLE_DATA_INPUTS', message: 'A data input accepts only one connection', path: `edges[${index}]`, severity: 'error' });
      return;
    }
    inputConnections.add(inputKey);
    validEdges.push(edge);
  });
  const cycle = findCycle(graph, validEdges);
  if (cycle) issues.push({ code: 'IMPLICIT_EXECUTION_CYCLE', message: `Execution cycle requires an explicit loop, timer, delay, or event boundary: ${cycle.join(' -> ')}`, path: 'edges', severity: 'error' });
  return issues;
}

export function compileBlueprint(graph: LillyBlueprint): LillyGraphIR {
  const issues = validateBlueprint(graph).filter((issue) => issue.severity === 'error');
  if (issues.length) throw Object.assign(new Error(issues.map((issue) => issue.message).join('; ')), { code: 'INVALID_BLUEPRINT', issues });
  const instructions = graph.nodes.map((node) => {
    const next: Record<string, string[]> = {};
    graph.edges.filter((edge) => edge.sourceNodeId === node.id).forEach((edge) => {
      next[edge.sourcePinId] = [...(next[edge.sourcePinId] || []), edge.targetNodeId];
    });
    return { id: node.id, opcode: node.type, args: { ...(node.config || {}) }, next };
  });
  const entrypoints = graph.nodes
    .filter((node) => node.type.startsWith('event.'))
    .map((node) => ({ event: node.type.slice('event.'.length), instructionId: node.id }));
  return { schema: GRAPH_IR_SCHEMA, graphId: graph.id, graphName: graph.name, variables: graph.variables, entrypoints, instructions };
}

export type BlueprintCapabilityApi = {
  entity: {
    setEnabled(id: string, enabled: boolean): void;
    move(id: string, delta: { x: number; y: number; z: number }): void;
    destroy(id: string): void;
  };
  physics: { force(id: string, vector: { x: number; y: number; z: number }): void; impulse(id: string, vector: { x: number; y: number; z: number }): void };
  presentation: { hud(message: string): void; audio(assetId: string): void; particles(entityId: string): void };
  debug: { log(...values: unknown[]): void };
};

export class BlueprintExecutor {
  private variables = new Map<string, unknown>();
  private instructionMap: Map<string, LillyGraphIRInstruction>;

  constructor(private ir: LillyGraphIR, private capabilities: BlueprintCapabilityApi) {
    this.instructionMap = new Map(ir.instructions.map((instruction) => [instruction.id, instruction]));
    ir.variables.forEach((variable) => this.variables.set(variable.id, variable.defaultValue));
  }

  emit(event: string, context: Record<string, unknown> = {}) {
    const entrypoints = this.ir.entrypoints.filter((entry) => entry.event === event);
    entrypoints.forEach((entry) => this.run(entry.instructionId, context, new Set(), 0));
  }

  private run(id: string, context: Record<string, unknown>, active: Set<string>, depth: number) {
    if (depth > 256) throw Object.assign(new Error('Blueprint execution budget exceeded'), { code: 'BLUEPRINT_BUDGET_EXCEEDED' });
    const instruction = this.instructionMap.get(id);
    if (!instruction) return;
    if (active.has(id) && !NODE_REGISTRY[instruction.opcode]?.boundary) throw Object.assign(new Error(`Blueprint re-entered ${id} without a boundary`), { code: 'BLUEPRINT_RUNTIME_CYCLE' });
    const nextActive = new Set(active).add(id);
    switch (instruction.opcode) {
      case 'variable.add': {
        const variableId = String(instruction.args.variableId || '');
        this.variables.set(variableId, Number(this.variables.get(variableId) || 0) + Number(instruction.args.amount || 1));
        break;
      }
      case 'presentation.hud-message': this.capabilities.presentation.hud(String(instruction.args.message || '')); break;
      case 'presentation.audio': this.capabilities.presentation.audio(String(instruction.args.assetId || '')); break;
      case 'presentation.particles': this.capabilities.presentation.particles(String(context.entityId || instruction.args.entityId || '')); break;
      case 'utility.debug-log': this.capabilities.debug.log(instruction.args.value, context); break;
      default: break;
    }
    const output = instruction.opcode === 'flow.branch'
      ? (this.evaluateBranch(instruction.args) ? 'true' : 'false')
      : 'exec-out';
    (instruction.next[output] || Object.values(instruction.next).flat()).forEach((nextId) => this.run(nextId, context, nextActive, depth + 1));
  }

  private evaluateBranch(args: Record<string, unknown>) {
    const expression = String(args.expression || '').trim();
    const match = expression.match(/^([a-zA-Z0-9_-]+)\s*(>=|<=|===|==|>|<)\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) return Boolean(args.condition);
    const left = Number(this.variables.get(match[1]) || 0);
    const right = Number(match[3]);
    return ({ '>=': left >= right, '<=': left <= right, '>': left > right, '<': left < right, '==': left === right, '===': left === right } as Record<string, boolean>)[match[2]];
  }
}
