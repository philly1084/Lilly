import { useMemo, useState } from 'react';
import type { LillyEntity } from '../types';
import { currentScene, useStudioStore } from '../store';
import { Icon } from './Icon';

function entityIcon(entity: LillyEntity): Parameters<typeof Icon>[0]['name'] {
  if (entity.components.some((component) => component.type === 'Camera')) return 'camera';
  if (entity.components.some((component) => component.type === 'Light')) return 'light';
  if (entity.components.some((component) => component.type === 'Blueprint')) return 'blueprint';
  return 'cube';
}

function TreeItem({ entity, all, depth, query }: { entity: LillyEntity; all: LillyEntity[]; depth: number; query: string }) {
  const [expanded, setExpanded] = useState(true);
  const selected = useStudioStore((state) => state.selectedEntityId === entity.id);
  const { selectEntity, setEntityEnabled, setEntityLocked, reparentEntity } = useStudioStore();
  const children = all.filter((candidate) => candidate.parentId === entity.id);
  const matches = !query || entity.name.toLowerCase().includes(query) || entity.tags.some((tag) => tag.includes(query));
  const childMatches = children.some((child) => child.name.toLowerCase().includes(query));
  if (!matches && !childMatches) return null;
  return <div className="tree-branch">
    <div
      className={`tree-row${selected ? ' selected' : ''}${!entity.enabled ? ' disabled' : ''}`}
      style={{ '--tree-depth': depth } as React.CSSProperties}
      draggable={!entity.locked}
      onDragStart={(event) => event.dataTransfer.setData('application/x-lilly-entity', entity.id)}
      onDragOver={(event) => { event.preventDefault(); event.currentTarget.classList.add('drag-target'); }}
      onDragLeave={(event) => event.currentTarget.classList.remove('drag-target')}
      onDrop={(event) => { event.preventDefault(); event.currentTarget.classList.remove('drag-target'); const source = event.dataTransfer.getData('application/x-lilly-entity'); if (source && source !== entity.id) reparentEntity(source, entity.id); }}
      onClick={() => selectEntity(entity.id)}
    >
      <button type="button" className="tree-disclosure" onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }} aria-label={expanded ? 'Collapse entity' : 'Expand entity'}>{children.length ? (expanded ? '▾' : '▸') : ''}</button>
      <Icon name={entityIcon(entity)} size={14}/><span className="tree-name">{entity.name}</span>
      <button type="button" className="tree-state" onClick={(event) => { event.stopPropagation(); setEntityEnabled(entity.id, !entity.enabled); }} title={entity.enabled ? 'Hide entity' : 'Show entity'}><Icon name={entity.enabled ? 'eye' : 'eyeOff'} size={13}/></button>
      <button type="button" className="tree-state" onClick={(event) => { event.stopPropagation(); setEntityLocked(entity.id, !entity.locked); }} title={entity.locked ? 'Unlock entity' : 'Lock entity'}><Icon name={entity.locked ? 'lock' : 'unlock'} size={13}/></button>
    </div>
    {expanded && children.map((child) => <TreeItem key={child.id} entity={child} all={all} depth={depth + 1} query={query}/>)}
  </div>;
}

export function Hierarchy() {
  const current = useStudioStore((state) => state.current);
  const reparentEntity = useStudioStore((state) => state.reparentEntity);
  const [search, setSearch] = useState('');
  const scene = currentScene(current);
  const roots = useMemo(() => scene?.entities.filter((entity) => !entity.parentId) || [], [scene]);
  const query = search.trim().toLowerCase();
  return <aside className="hierarchy-panel studio-panel">
    <div className="panel-heading"><div><span className="panel-kicker">Scene</span><strong>Hierarchy</strong></div><button type="button" className="icon-button" title="Create entity"><Icon name="add"/></button></div>
    <div className="search-field"><Icon name="search" size={14}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search entities" aria-label="Search entities"/></div>
    <div className="scene-row"><span className="scene-badge">3D</span><strong>{scene?.name || 'No scene'}</strong><small>{scene?.entities.length || 0}</small></div>
    <div className="hierarchy-tree" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const source = event.dataTransfer.getData('application/x-lilly-entity'); if (source && event.target === event.currentTarget) reparentEntity(source, null); }}>
      {roots.map((entity) => <TreeItem key={entity.id} entity={entity} all={scene?.entities || []} depth={0} query={query}/>)}
      {!roots.length && <div className="panel-empty">This scene has no entities.</div>}
    </div>
    <div className="panel-footer"><span><kbd>F</kbd> Focus</span><span>Drag to reparent</span></div>
  </aside>;
}
