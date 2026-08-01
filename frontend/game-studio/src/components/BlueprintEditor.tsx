import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { canConnectPins, NODE_REGISTRY, validateBlueprint } from '../../../../packages/lilly-engine/blueprints/src';
import type { LillyBlueprint, LillyBlueprintNode, LillyBlueprintPin } from '../types';
import { useStudioStore } from '../store';
import { Icon } from './Icon';

type BlueprintNodeData = { node: LillyBlueprintNode } & Record<string, unknown>;

function BlueprintNodeView({ data, selected }: NodeProps<Node<BlueprintNodeData>>) {
  const node = data.node;
  const definition = NODE_REGISTRY[node.type];
  const pins = node.pins.length ? node.pins : definition?.pins || [];
  const family = definition?.family || 'utility';
  return <div className={`blueprint-node family-${family}${selected ? ' selected' : ''}`}>
    <div className="blueprint-node-header"><span className="node-family-dot"/><Icon name={family === 'events' ? 'play' : family === 'presentation' ? 'spark' : family === 'transform-physics' ? 'translate' : 'blueprint'} size={13}/><strong>{node.label || definition?.label || node.type}</strong></div>
    <div className="blueprint-node-body">
      {pins.map((pin) => <div key={pin.id} className={`pin-row ${pin.direction}`}>
        {pin.direction === 'input' && <Handle id={pin.id} type="target" position={Position.Left} className={`pin pin-${pin.kind} data-${pin.dataType || 'exec'}`}/>}
        <span>{pin.name}</span>{pin.dataType && <small>{pin.dataType}</small>}
        {pin.direction === 'output' && <Handle id={pin.id} type="source" position={Position.Right} className={`pin pin-${pin.kind} data-${pin.dataType || 'exec'}`}/>}
      </div>)}
      {node.config && Object.keys(node.config).length > 0 && <div className="node-config">{Object.entries(node.config).slice(0, 2).map(([key, value]) => <span key={key}><small>{key}</small>{String(value)}</span>)}</div>}
    </div>
  </div>;
}

const nodeTypes = { blueprint: BlueprintNodeView };

function flowNodes(graph: LillyBlueprint): Node<BlueprintNodeData>[] {
  return graph.nodes.map((node) => ({ id: node.id, type: 'blueprint', position: node.position, data: { node } }));
}

function flowEdges(graph: LillyBlueprint): Edge[] {
  return graph.edges.map((edge) => ({ id: edge.id, source: edge.sourceNodeId, sourceHandle: edge.sourcePinId, target: edge.targetNodeId, targetHandle: edge.targetPinId, type: 'smoothstep', animated: edge.sourcePinId.includes('exec') || edge.sourcePinId === 'true', style: { stroke: edge.sourcePinId === 'true' ? '#6ee7b7' : '#72a7c7', strokeWidth: 1.8 } }));
}

function findPin(graph: LillyBlueprint, nodeId: string, pinId: string): LillyBlueprintPin | null {
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (!node) return null;
  return node.pins.find((pin) => pin.id === pinId) || NODE_REGISTRY[node.type]?.pins.find((pin) => pin.id === pinId) || null;
}

export function BlueprintEditor() {
  const current = useStudioStore((state) => state.current);
  const selectedGraphId = useStudioStore((state) => state.selectedGraphId);
  const setSelectedGraph = useStudioStore((state) => state.setSelectedGraph);
  const dispatch = useStudioStore((state) => state.dispatch);
  const graph = current?.project.blueprints.find((entry) => entry.id === selectedGraphId) || current?.project.blueprints[0] || null;
  const [nodes, setNodes] = useState<Node<BlueprintNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [dirty, setDirty] = useState(false);
  const [nodeMenuOpen, setNodeMenuOpen] = useState(false);

  useEffect(() => {
    if (!graph) return;
    setNodes(flowNodes(graph)); setEdges(flowEdges(graph)); setDirty(false);
  }, [graph?.id, current?.project.revision]);

  const draftGraph = useMemo<LillyBlueprint | null>(() => graph ? {
    ...graph,
    nodes: nodes.map((flowNode) => ({ ...flowNode.data.node, position: flowNode.position })),
    edges: edges.map((edge) => ({ id: edge.id, sourceNodeId: edge.source, sourcePinId: edge.sourceHandle || 'exec-out', targetNodeId: edge.target, targetPinId: edge.targetHandle || 'exec-in' })),
  } : null, [graph, nodes, edges]);
  const issues = draftGraph ? validateBlueprint(draftGraph).filter((issue) => issue.severity === 'error') : [];

  const onNodesChange = (changes: NodeChange<Node<BlueprintNodeData>>[]) => { setNodes((currentNodes) => applyNodeChanges(changes, currentNodes)); setDirty(true); };
  const onEdgesChange = (changes: EdgeChange[]) => { setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges)); setDirty(true); };
  const isValidConnection = (connection: Edge | Connection) => Boolean(draftGraph && connection.source && connection.target && connection.sourceHandle && connection.targetHandle && canConnectPins(findPin(draftGraph, connection.source, connection.sourceHandle), findPin(draftGraph, connection.target, connection.targetHandle)));
  const onConnect = (connection: Connection) => { if (!isValidConnection(connection)) return; setEdges((currentEdges) => addEdge({ ...connection, id: crypto.randomUUID(), type: 'smoothstep', animated: true, style: { stroke: '#72a7c7', strokeWidth: 1.8 } }, currentEdges)); setDirty(true); };
  const save = async () => {
    if (!draftGraph || issues.length) return;
    const success = await dispatch([{ operation: 'blueprint.replace', target: { graphId: draftGraph.id }, payload: { graph: draftGraph } }], 'blueprint-editor');
    if (success) setDirty(false);
  };
  const addNode = (type: string) => {
    const definition = NODE_REGISTRY[type];
    const id = `${type.replace(/\W/g, '-')}-${crypto.randomUUID().slice(0, 5)}`;
    const node: LillyBlueprintNode = { id, type, label: definition.label, position: { x: 160 + nodes.length * 28, y: 120 + nodes.length * 18 }, pins: definition.pins.map((pin) => ({ ...pin })) };
    setNodes((currentNodes) => [...currentNodes, { id, type: 'blueprint', position: node.position, data: { node } }]);
    setDirty(true); setNodeMenuOpen(false);
  };

  if (!graph) return <div className="workspace-empty"><Icon name="blueprint" size={28}/><strong>No Blueprint graph</strong><span>Add a Blueprint component or create a graph.</span></div>;
  return <div className="blueprint-workspace">
    <div className="blueprint-sidebar">
      <div className="workspace-subheading"><span>Graphs</span><button type="button"><Icon name="add" size={13}/></button></div>
      {current?.project.blueprints.map((entry) => <button type="button" key={entry.id} className={entry.id === graph.id ? 'active' : ''} onClick={() => setSelectedGraph(entry.id)}><Icon name="blueprint" size={14}/><span>{entry.name}</span><small>{entry.nodes.length}</small></button>)}
      <div className="workspace-subheading variables"><span>Variables</span><button type="button"><Icon name="add" size={13}/></button></div>
      {graph.variables.map((variable) => <div className="variable-row" key={variable.id}><i className={`variable-type type-${variable.dataType}`}/><span>{variable.name}</span><small>{variable.dataType}</small></div>)}
    </div>
    <div className="blueprint-canvas">
      <div className="blueprint-toolbar"><div><strong>{graph.name}</strong><span className={issues.length ? 'graph-invalid' : 'graph-valid'}>{issues.length ? `${issues.length} graph error${issues.length === 1 ? '' : 's'}` : 'Graph valid'}</span>{dirty && <span className="graph-dirty">Unsaved</span>}</div><div className="node-add-wrap"><button type="button" onClick={() => setNodeMenuOpen((value) => !value)}><Icon name="add" size={13}/>Node</button>{nodeMenuOpen && <div className="node-menu surface-popover">{Object.values(NODE_REGISTRY).slice(0, 18).map((definition) => <button key={definition.type} type="button" onClick={() => addNode(definition.type)}><span>{definition.label}</span><small>{definition.family}</small></button>)}</div>}<button type="button" className="primary-small" onClick={save} disabled={!dirty || Boolean(issues.length)}>Compile & save</button></div></div>
      {issues.length > 0 && <div className="graph-error-banner"><strong>Invalid graph</strong><span>{issues[0].message}</span></div>}
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection} fitView minZoom={0.25} maxZoom={1.7} colorMode="dark" deleteKeyCode={['Backspace', 'Delete']}>
        <Background color="#1e3442" gap={22} size={1}/><MiniMap pannable zoomable nodeColor="#294658" maskColor="rgba(5,10,15,.68)"/><Controls showInteractive={false}/>
      </ReactFlow>
    </div>
  </div>;
}
