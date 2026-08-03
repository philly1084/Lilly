import { useEffect, useState } from 'react';
import { COMPONENT_DEFINITIONS } from '../../../../packages/lilly-engine/core/src';
import type { LillyComponent, LillyComponentType, Vec3 } from '../types';
import { currentEntity, useStudioStore } from '../store';
import { Icon } from './Icon';

function NumberField({ label, value, onCommit, step = 0.1 }: { label: string; value: number; onCommit(value: number): void; step?: number }) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))));
  useEffect(() => setDraft(String(Number(value.toFixed(3)))), [value]);
  return <label className="number-field"><span>{label}</span><input type="number" value={draft} step={step} onChange={(event) => setDraft(event.target.value)} onBlur={() => { const parsed = Number(draft); if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed); else setDraft(String(value)); }}/></label>;
}

function VectorEditor({ label, value, onCommit }: { label: string; value: Vec3; onCommit(value: Vec3): void }) {
  return <div className="property-row vector-row"><span className="property-label">{label}</span><div className="vector-fields">{(['x', 'y', 'z'] as const).map((axis) => <NumberField key={axis} label={axis.toUpperCase()} value={Number(value?.[axis] || 0)} onCommit={(next) => onCommit({ ...value, [axis]: next })}/>)}</div></div>;
}

function ComponentBody({ component, onChange }: { component: LillyComponent; onChange(next: LillyComponent): void }) {
  const current = useStudioStore((state) => state.current);
  const data = component.data as Record<string, unknown>;
  if (component.type === 'Transform') return <>
    <VectorEditor label="Position" value={data.position as Vec3} onCommit={(value) => onChange({ ...component, data: { ...data, position: value } })}/>
    <VectorEditor label="Rotation" value={data.rotation as Vec3} onCommit={(value) => onChange({ ...component, data: { ...data, rotation: value } })}/>
    <VectorEditor label="Scale" value={data.scale as Vec3} onCommit={(value) => onChange({ ...component, data: { ...data, scale: value } })}/>
  </>;
  if (component.type === 'MeshRenderer') {
    const material = (data.material || {}) as Record<string, unknown>;
    return <>
      <div className="property-row"><span className="property-label">Model asset</span><select value={String(data.assetId || '')} onChange={(event) => onChange({ ...component, data: { ...data, assetId: event.target.value } })}><option value="">Primitive geometry</option>{(current?.project.assets || []).filter((asset) => asset.type.startsWith('model/') || /\.glb$/i.test(asset.uri)).map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></div>
      <div className="property-row"><span className="property-label">Material</span><select value={String(data.materialId || '')} onChange={(event) => onChange({ ...component, data: { ...data, materialId: event.target.value } })}><option value="">Inline material</option>{(current?.moduleSummary.materials || []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></div>
      <div className="property-row"><span className="property-label">Geometry</span><select value={String(data.geometry || 'box')} onChange={(event) => onChange({ ...component, data: { ...data, geometry: event.target.value } })}><option>box</option><option>sphere</option><option>capsule</option><option>cylinder</option><option>octahedron</option><option>torus</option></select></div>
      <div className="property-row"><span className="property-label">Color</span><div className="color-input"><input type="color" value={String(material.color || '#8ea7c4')} onChange={(event) => onChange({ ...component, data: { ...data, material: { ...material, color: event.target.value } } })}/><code>{String(material.color || '#8ea7c4')}</code></div></div>
      <div className="property-row"><span className="property-label">Roughness</span><input className="range" type="range" min="0" max="1" step="0.05" value={Number(material.roughness ?? 0.65)} onChange={(event) => onChange({ ...component, data: { ...data, material: { ...material, roughness: Number(event.target.value) } } })}/><span className="range-value">{Number(material.roughness ?? 0.65).toFixed(2)}</span></div>
      <div className="property-row"><span className="property-label">Metalness</span><input className="range" type="range" min="0" max="1" step="0.05" value={Number(material.metalness ?? 0.05)} onChange={(event) => onChange({ ...component, data: { ...data, material: { ...material, metalness: Number(event.target.value) } } })}/><span className="range-value">{Number(material.metalness ?? 0.05).toFixed(2)}</span></div>
      <div className="property-row"><span className="property-label">Emissive</span><div className="color-input"><input type="color" value={String(material.emissive || '#000000')} onChange={(event) => onChange({ ...component, data: { ...data, material: { ...material, emissive: event.target.value } } })}/><code>{String(material.emissive || '#000000')}</code></div></div>
      <label className="check-row"><input type="checkbox" checked={data.castShadow !== false} onChange={(event) => onChange({ ...component, data: { ...data, castShadow: event.target.checked } })}/><span>Cast shadows</span></label>
      <label className="check-row"><input type="checkbox" checked={data.receiveShadow !== false} onChange={(event) => onChange({ ...component, data: { ...data, receiveShadow: event.target.checked } })}/><span>Receive shadows</span></label>
    </>;
  }
  if (component.type === 'Terrain') return <>
    <div className="property-row"><span className="property-label">Heightfield</span><select value={String(data.terrainId || '')} onChange={(event) => onChange({ ...component, data: { ...data, terrainId: event.target.value } })}><option value="">Select terrain</option>{(current?.moduleSummary.terrains || []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.resolution}²</option>)}</select></div>
    <label className="check-row"><input type="checkbox" checked={data.walkable !== false} onChange={(event) => onChange({ ...component, data: { ...data, walkable: event.target.checked } })}/><span>Walkable surface</span></label>
    <label className="check-row"><input type="checkbox" checked={data.collision !== false} onChange={(event) => onChange({ ...component, data: { ...data, collision: event.target.checked } })}/><span>Heightfield collision intent</span></label>
    <div className="property-hint">Terrain heights are deterministic source data. V1 player collision uses the authored XZ footprint while heightfield physics is promoted next.</div>
  </>;
  if (component.type === 'Animator') return <>
    <div className="property-row"><span className="property-label">Controller</span><select value={String(data.controllerId || '')} onChange={(event) => onChange({ ...component, data: { ...data, controllerId: event.target.value, state: '' } })}><option value="">Direct GLB clip</option>{(current?.moduleSummary.animations || []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></div>
    {data.controllerId ? <div className="property-row"><span className="property-label">State</span><select value={String(data.state || '')} onChange={(event) => onChange({ ...component, data: { ...data, state: event.target.value } })}><option value="">Controller default</option>{current?.moduleSummary.animations.find((entry) => entry.id === data.controllerId)?.states.map((state) => <option key={state.id} value={state.id}>{state.id} · {state.mode}</option>)}</select></div> : <div className="property-row"><span className="property-label">Clip</span><input value={String(data.clip || '')} placeholder="GLB clip name" onChange={(event) => onChange({ ...component, data: { ...data, clip: event.target.value } })}/></div>}
    <div className="property-row"><span className="property-label">Speed</span><NumberField label="×" value={Number(data.speed ?? 1)} step={0.1} onCommit={(value) => onChange({ ...component, data: { ...data, speed: value } })}/></div>
    <label className="check-row"><input type="checkbox" checked={data.autoplay !== false} onChange={(event) => onChange({ ...component, data: { ...data, autoplay: event.target.checked } })}/><span>Autoplay in editor and player</span></label>
  </>;
  if (component.type === 'Light') return <>
    <div className="property-row"><span className="property-label">Type</span><select value={String(data.kind || 'directional')} onChange={(event) => onChange({ ...component, data: { ...data, kind: event.target.value } })}><option>directional</option><option>point</option><option>spot</option><option>hemisphere</option></select></div>
    <div className="property-row"><span className="property-label">Color</span><input type="color" value={String(data.color || '#ffffff')} onChange={(event) => onChange({ ...component, data: { ...data, color: event.target.value } })}/></div>
    <div className="property-row"><span className="property-label">Intensity</span><NumberField label="" value={Number(data.intensity || 0)} step={0.5} onCommit={(value) => onChange({ ...component, data: { ...data, intensity: value } })}/></div>
  </>;
  if (component.type === 'RigidBody') return <>
    <div className="property-row"><span className="property-label">Body type</span><select value={String(data.bodyType || 'dynamic')} onChange={(event) => onChange({ ...component, data: { ...data, bodyType: event.target.value } })}><option value="dynamic">Dynamic</option><option value="fixed">Fixed</option><option value="kinematic-position">Kinematic</option></select></div>
    <div className="property-row"><span className="property-label">Mass</span><NumberField label="kg" value={Number(data.mass || 1)} onCommit={(value) => onChange({ ...component, data: { ...data, mass: value } })}/></div>
  </>;
  if (component.type === 'Collider') return <>
    <div className="property-row"><span className="property-label">Shape</span><select value={String(data.shape || 'box')} onChange={(event) => onChange({ ...component, data: { ...data, shape: event.target.value } })}><option>box</option><option>sphere</option><option>capsule</option><option>cylinder</option></select></div>
    <label className="check-row"><input type="checkbox" checked={data.sensor === true} onChange={(event) => onChange({ ...component, data: { ...data, sensor: event.target.checked } })}/><span>Is trigger</span></label>
  </>;
  if (component.type === 'Health') return <>
    <div className="property-row"><span className="property-label">Maximum</span><NumberField label="HP" value={Number(data.max || 1)} step={1} onCommit={(value) => onChange({ ...component, data: { ...data, max: value, current: Math.min(value, Number(data.current || value)) } })}/></div>
    <div className="property-row"><span className="property-label">Current</span><NumberField label="HP" value={Number(data.current ?? data.max ?? 1)} step={1} onCommit={(value) => onChange({ ...component, data: { ...data, current: value } })}/></div>
    <div className="property-row"><span className="property-label">Hit grace</span><NumberField label="s" value={Number(data.invulnerabilitySeconds || 0)} step={0.05} onCommit={(value) => onChange({ ...component, data: { ...data, invulnerabilitySeconds: value } })}/></div>
  </>;
  if (component.type === 'Combatant') return <>
    <div className="property-row"><span className="property-label">Team</span><select value={String(data.team || 'neutral')} onChange={(event) => onChange({ ...component, data: { ...data, team: event.target.value } })}><option>player</option><option>enemy</option><option>neutral</option></select></div>
    <div className="property-row"><span className="property-label">Damage</span><NumberField label="HP" value={Number(data.damage || 1)} step={1} onCommit={(value) => onChange({ ...component, data: { ...data, damage: value } })}/></div>
    <div className="property-row"><span className="property-label">Range</span><NumberField label="m" value={Number(data.range || 1)} onCommit={(value) => onChange({ ...component, data: { ...data, range: value } })}/></div>
    <div className="property-row"><span className="property-label">Cooldown</span><NumberField label="s" value={Number(data.cooldownSeconds || 0.5)} step={0.05} onCommit={(value) => onChange({ ...component, data: { ...data, cooldownSeconds: value } })}/></div>
  </>;
  if (component.type === 'EnemyBrain') return <>
    <div className="property-row"><span className="property-label">Behavior</span><select value={String(data.behavior || 'chaser')} onChange={(event) => onChange({ ...component, data: { ...data, behavior: event.target.value } })}><option value="chaser">Chaser</option></select></div>
    <div className="property-row"><span className="property-label">Move speed</span><NumberField label="m/s" value={Number(data.moveSpeed || 1)} onCommit={(value) => onChange({ ...component, data: { ...data, moveSpeed: value } })}/></div>
    <div className="property-row"><span className="property-label">Detection</span><NumberField label="m" value={Number(data.detectionRange || 8)} onCommit={(value) => onChange({ ...component, data: { ...data, detectionRange: value } })}/></div>
    <div className="property-row"><span className="property-label">Attack range</span><NumberField label="m" value={Number(data.attackRange || 1)} onCommit={(value) => onChange({ ...component, data: { ...data, attackRange: value } })}/></div>
    <div className="property-row"><span className="property-label">Windup</span><NumberField label="s" value={Number(data.windupSeconds || 0.3)} step={0.05} onCommit={(value) => onChange({ ...component, data: { ...data, windupSeconds: value } })}/></div>
    <div className="property-row"><span className="property-label">Recovery</span><NumberField label="s" value={Number(data.recoverSeconds || 0.7)} step={0.05} onCommit={(value) => onChange({ ...component, data: { ...data, recoverSeconds: value } })}/></div>
  </>;
  if (component.type === 'EncounterMember' || component.type === 'EncounterGate' || component.type === 'Checkpoint') return <>
    <div className="property-row"><span className="property-label">Encounter</span><code className="asset-reference">{String(data.encounterId || 'Not assigned')}</code></div>
    {component.type === 'EncounterMember' && <div className="property-row"><span className="property-label">Role</span><code className="asset-reference">Combat member</code></div>}
    {component.type === 'EncounterGate' && <label className="check-row"><input type="checkbox" checked={data.startsOpen === true} onChange={(event) => onChange({ ...component, data: { ...data, startsOpen: event.target.checked } })}/><span>Open before encounter</span></label>}
    {component.type === 'Checkpoint' && <><div className="property-row"><span className="property-label">Checkpoint</span><code className="asset-reference">{String(data.checkpointId || 'Not assigned')}</code></div><div className="property-row"><span className="property-label">Activates</span><code className="asset-reference">{String(data.activate || 'encounter-clear')}</code></div></>}
  </>;
  if (component.type === 'Blueprint') return <div className="property-row"><span className="property-label">Graph</span><code className="asset-reference">{String(data.graphId || 'Not assigned')}</code></div>;
  if (component.type === 'Script') return <><div className="property-row"><span className="property-label">Sandbox</span><span className="security-pill">Opaque origin</span></div><div className="capability-list">{(data.capabilities as string[] || []).map((capability) => <code key={capability}>{capability}</code>)}</div></>;
  return <pre className="component-json">{JSON.stringify(data, null, 2)}</pre>;
}

function ComponentCard({ component, entityId }: { component: LillyComponent; entityId: string }) {
  const [open, setOpen] = useState(true);
  const { setComponent, removeComponent } = useStudioStore();
  return <section className="component-card">
    <header><button type="button" className="component-title" onClick={() => setOpen((value) => !value)}><span>{open ? '▾' : '▸'}</span><Icon name={component.type === 'Blueprint' ? 'blueprint' : component.type === 'Script' ? 'code' : component.type === 'Light' ? 'light' : 'cube'} size={14}/><strong>{component.type}</strong></button><button type="button" className="icon-button subtle" onClick={() => removeComponent(entityId, component.type)} disabled={component.type === 'Transform'} title="Remove component"><Icon name="dots" size={14}/></button></header>
    {open && <div className="component-content"><ComponentBody component={component} onChange={(next) => setComponent(entityId, next)}/></div>}
  </section>;
}

export function Inspector() {
  const current = useStudioStore((state) => state.current);
  const selectedEntityId = useStudioStore((state) => state.selectedEntityId);
  const entity = currentEntity(current, selectedEntityId);
  const { renameEntity, addComponent } = useStudioStore();
  const [name, setName] = useState(entity?.name || '');
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => setName(entity?.name || ''), [entity?.id, entity?.name]);
  if (!entity) return <aside className="inspector-panel studio-panel"><div className="panel-heading"><div><span className="panel-kicker">Properties</span><strong>Inspector</strong></div></div><div className="panel-empty tall"><Icon name="cube" size={28}/><strong>No entity selected</strong><span>Select an entity in the hierarchy or viewport.</span></div></aside>;
  const available = (Object.keys(COMPONENT_DEFINITIONS) as LillyComponentType[]).filter((type) => !entity.components.some((component) => component.type === type));
  return <aside className="inspector-panel studio-panel">
    <div className="panel-heading"><div><span className="panel-kicker">Properties</span><strong>Inspector</strong></div><button type="button" className="icon-button"><Icon name="dots"/></button></div>
    <div className="entity-header"><div className="entity-avatar"><Icon name="cube"/></div><div><input className="entity-name-input" value={name} onChange={(event) => setName(event.target.value)} onBlur={() => { if (name.trim() && name.trim() !== entity.name) renameEntity(entity.id, name.trim()); else setName(entity.name); }}/><small>{entity.id}</small></div></div>
    <div className="tag-list">{entity.tags.map((tag) => <span key={tag}>{tag}</span>)}<button type="button">+ tag</button></div>
    <div className="component-scroll">{entity.components.map((component) => <ComponentCard key={component.type} component={component} entityId={entity.id}/>)}</div>
    <div className="add-component-wrap"><button type="button" className="add-component-button" onClick={() => setAddOpen((value) => !value)}><Icon name="add"/>Add component</button>{addOpen && <div className="add-component-menu surface-popover"><div className="menu-label">Component registry</div>{available.map((type) => <button key={type} type="button" onClick={() => { addComponent(entity.id, { type, enabled: true, data: structuredClone(COMPONENT_DEFINITIONS[type].defaults) }); setAddOpen(false); }}><span>{type}</span><small>{type === 'Script' ? 'Sandboxed' : 'Lilly Engine'}</small></button>)}</div>}</div>
  </aside>;
}
