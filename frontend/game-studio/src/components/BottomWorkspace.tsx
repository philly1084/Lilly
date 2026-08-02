import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { BottomTab, StudioBuild } from '../types';
import { currentScene, useStudioStore } from '../store';
import { BlueprintEditor } from './BlueprintEditor';
import { Icon } from './Icon';

const tabs: Array<{ id: BottomTab; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { id: 'content', label: 'Content Browser', icon: 'content' },
  { id: 'blueprints', label: 'Blueprints', icon: 'blueprint' },
  { id: 'typescript', label: 'Code & Modules', icon: 'code' },
  { id: 'console', label: 'Console', icon: 'console' },
  { id: 'tests', label: 'Tests', icon: 'test' },
  { id: 'build', label: 'Build Output', icon: 'build' },
];

function ContentBrowser() {
  const current = useStudioStore((state) => state.current);
  const importProject = useStudioStore((state) => state.importProject);
  const instantiatePrefab = useStudioStore((state) => state.instantiatePrefab);
  const scene = currentScene(current);
  const [query, setQuery] = useState('');
  const items = useMemo(() => [
    ...(current?.project.assets || []).map((asset) => ({ id: asset.id, name: asset.name, type: asset.type, kind: 'asset' })),
    ...(scene?.entities.filter((entity) => ['pickup', 'player', 'enemy', 'checkpoint'].some((tag) => entity.tags.includes(tag))).map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.tags.includes('player') ? 'Player prefab' : entity.tags.includes('enemy') ? 'Enemy prefab' : entity.tags.includes('checkpoint') ? 'Checkpoint prefab' : 'Collectible prefab',
      kind: 'prefab',
    })) || []),
    ...(current?.project.blueprints.map((graph) => ({ id: graph.id, name: graph.name, type: `${graph.nodes.length} nodes`, kind: 'blueprint' })) || []),
    ...(current?.moduleSummary.prefabs.map((prefab) => ({ id: `module:${prefab.id}`, name: prefab.name, type: `${prefab.moduleId} prefab`, kind: 'prefab', sourcePath: prefab.sourcePath })) || []),
  ].filter((item) => item.name.toLowerCase().includes(query.toLowerCase())), [current, scene, query]);
  return <div className="content-browser"><div className="content-sidebar"><button type="button" className="active">All Content</button><button type="button">Assets</button><button type="button">Prefabs</button><button type="button">Scenes</button><button type="button">Audio</button></div><div className="content-main"><div className="content-actions"><div className="search-field compact"><Icon name="search" size={13}/><input placeholder="Filter content" value={query} onChange={(event) => setQuery(event.target.value)}/></div><input id="game-studio-import" className="visually-hidden" type="file" accept=".json,.html,text/html,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) importProject(file); event.currentTarget.value = ''; }}/><button type="button" onClick={() => document.getElementById('game-studio-import')?.click()} title="Import a LillyProject/v1 JSON file or compatible HTML/Three.js bundle"><Icon name="add" size={13}/>Import project</button></div><div className="asset-grid">{items.map((item) => <button type="button" className="asset-card" key={item.id} onDoubleClick={() => 'sourcePath' in item && item.sourcePath && instantiatePrefab(item.sourcePath, `${item.id.replace(/[^a-z0-9-]/gi, '-')}-${Date.now().toString(36)}`)} title={'sourcePath' in item ? 'Double-click to instantiate this module prefab in the active scene' : item.name}><div className={`asset-thumb kind-${item.kind}`}><Icon name={item.kind === 'blueprint' ? 'blueprint' : item.kind === 'prefab' ? 'cube' : 'content'} size={24}/></div><strong>{item.name}</strong><small>{item.type}</small></button>)}{!items.length && <div className="workspace-empty"><strong>No matching content</strong><span>Import a GLB, texture, or audio file.</span></div>}</div></div></div>;
}

const starterScript = `import type { LillyScriptApi } from '@lilly/engine-runtime';

export default function playerBoost(api: LillyScriptApi) {
  api.events.on('input:Boost', ({ entityId }) => {
    api.physics.impulse(entityId, { x: 0, y: 0, z: -4 });
    api.presentation.particles(entityId);
  });
}
`;

function TypeScriptWorkspace() {
  const [source, setSource] = useState(starterScript);
  const forbidden = /\b(document|window|localStorage|fetch|XMLHttpRequest|WebSocket|cookie|parent)\b/.exec(source);
  return <div className="typescript-workspace"><div className="script-list"><div className="workspace-subheading"><span>Components</span><button type="button"><Icon name="add" size={13}/></button></div><button type="button" className="active"><Icon name="code" size={13}/><span>player-boost.ts</span><i className={forbidden ? 'error' : 'clean'}/></button><div className="sandbox-policy"><Icon name="lock" size={14}/><strong>Sandbox policy</strong><span>Opaque origin · 8 ms budget</span><code>entity.read</code><code>entity.write</code><code>physics.impulse</code><code>events.emit</code></div></div><div className="monaco-wrap"><div className={`compile-bar ${forbidden ? 'failed' : 'passed'}`}><span>{forbidden ? `Compile error: “${forbidden[0]}” is outside the capability API` : 'TypeScript component passes sandbox policy'}</span><button type="button" disabled={Boolean(forbidden)}>Compile</button></div><Editor height="100%" language="typescript" theme="vs-dark" value={source} onChange={(value) => setSource(value || '')} options={{ minimap: { enabled: false }, fontSize: 12, fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace', padding: { top: 14 }, scrollBeyondLastLine: false, tabSize: 2, wordWrap: 'on', renderLineHighlight: 'line', automaticLayout: true }}/></div></div>;
}

function mechanicPackageFiles(index: number) {
  const id = `mechanic-${index}`;
  const directory = `modules/${id}`;
  return [
    { path: `${directory}/${id}.module.json`, content: JSON.stringify({ schema: 'LillyGameModule/v1', id, name: `Mechanic ${index}`, version: '1.0.0', description: 'Agent-authored gameplay package', dependencies: [], capabilities: ['input.read', 'entity.spawn', 'events.emit', 'hud.write'], systems: [`./${id}.system.ts`], mechanics: [`./${id}.mechanic.json`], prefabs: [`./${id}-effect.prefab.json`], tests: [`./${id}.spec.json`] }, null, 2) },
    { path: `${directory}/${id}.mechanic.json`, content: JSON.stringify({ schema: 'LillyMechanic/v1', id, moduleId: id, name: `Mechanic ${index}`, description: 'A focused player verb with its own code, prefab, event, collision reaction, and test.', systems: [`./${id}.system.ts`], inputs: ['Ability1'], events: [`${id}.activated`, `${id}.collision`], components: [{ id: `${id}-state`, fields: [{ name: 'activations', type: 'number', defaultValue: 0 }, { name: 'collisions', type: 'number', defaultValue: 0 }] }] }, null, 2) },
    { path: `${directory}/${id}.system.ts`, content: `import { defineSystem } from '@lilly/engine-runtime';

export default defineSystem({
  id: '${id}',
  state: { activations: 0, collisions: 0 },
  onFixedUpdate(ctx) {
    if (!ctx.input.button('Ability1')) return;
    ctx.entities.spawn('${id}-effect', { parentId: ctx.world.playerId });
    ctx.events.emit('${id}.activated', { entityId: ctx.world.playerId });
    ctx.hud.message('Mechanic ${index} activated');
    ctx.state.activations += 1;
  },
  onCollision(ctx) {
    if (ctx.collision.phase !== 'start') return;
    if (ctx.collision.entityA !== ctx.world.playerId && ctx.collision.entityB !== ctx.world.playerId) return;
    ctx.events.emit('${id}.collision', { entityA: ctx.collision.entityA, entityB: ctx.collision.entityB, type: ctx.collision.type });
    ctx.hud.message('Mechanic ${index} collision received');
    ctx.state.collisions += 1;
  },
});
` },
    { path: `${directory}/${id}-effect.prefab.json`, content: JSON.stringify({ schema: 'LillyPrefab/v1', id: `${id}-effect`, moduleId: id, name: `Mechanic ${index} Effect`, rootEntityId: 'effect', entities: [{ schema: 'LillyEntity/v1', id: 'effect', name: `Mechanic ${index} Effect`, parentId: null, enabled: true, tags: ['fx', 'agent-authored'], components: [{ type: 'Transform', enabled: true, data: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.35, y: 0.35, z: 0.35 } } }, { type: 'MeshRenderer', enabled: true, data: { geometry: 'octahedron', material: { color: '#67e8f9', emissive: '#0891b2', emissiveIntensity: 0.8 } } }] }] }, null, 2) },
    { path: `${directory}/${id}.spec.json`, content: JSON.stringify({ schema: 'LillyMechanicTest/v1', id: `${id}-activates`, moduleId: id, name: `Mechanic ${index} activates from input and reacts to a trigger`, seed: index, steps: [{ event: 'fixed-update', delta: 1 / 60, input: { buttons: { Ability1: true } }, world: { playerId: 'player', entities: [{ id: 'player', tags: ['player'] }] } }, { event: 'collision', payload: { type: 'trigger', phase: 'start', entityA: 'player', entityB: 'test-trigger', tagsA: ['player'], tagsB: ['trigger'] }, world: { playerId: 'player', entities: [{ id: 'player', tags: ['player'] }, { id: 'test-trigger', tags: ['trigger'] }] } }], assertions: [{ path: 'actions[0].type', operator: 'equals', value: 'entity.spawn' }, { path: 'actions[1].type', operator: 'equals', value: 'events.emit' }, { path: `systems.${id}.state.activations`, operator: 'equals', value: 1 }, { path: `systems.${id}.state.collisions`, operator: 'equals', value: 1 }, { path: 'actions[3].name', operator: 'equals', value: `${id}.collision` }] }, null, 2) },
  ];
}

function ModuleWorkspace() {
  const current = useStudioStore((state) => state.current);
  const saveSourceFile = useStudioStore((state) => state.saveSourceFile);
  const saveSourceFiles = useStudioStore((state) => state.saveSourceFiles);
  const deleteSourceFile = useStudioStore((state) => state.deleteSourceFile);
  const dispatch = useStudioStore((state) => state.dispatch);
  const compileModules = useStudioStore((state) => state.compileModules);
  const runMechanicTests = useStudioStore((state) => state.runMechanicTests);
  const compile = useStudioStore((state) => state.latestModuleCompile);
  const mechanicTests = useStudioStore((state) => state.latestMechanicTestRun);
  const saveStatus = useStudioStore((state) => state.saveStatus);
  const files = current?.project.files || [];
  const [selectedPath, setSelectedPath] = useState('');
  const selected = files.find((file) => file.path === selectedPath) || files[0] || null;
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (!selectedPath && files[0]) setSelectedPath(files[0].path);
    if (selected) setDraft(selected.content);
  }, [selected?.path, selected?.content, selectedPath, files.length]);
  const diagnostics = (compile?.diagnostics || current?.validation.moduleIssues || []).filter((entry) => !selected || entry.path === selected.path);
  const dirty = Boolean(selected && draft !== selected.content);
  const createPackage = async () => {
    const index = (current?.moduleSummary.modules.length || 0) + 1;
    const packageFiles = mechanicPackageFiles(index);
    if (!await saveSourceFiles(packageFiles)) return;
    const refreshed = useStudioStore.getState().current;
    if (refreshed && !refreshed.project.inputMap.some((binding) => binding.action === 'Ability1')) {
      await dispatch([{ operation: 'input.replace', target: {}, payload: { inputMap: [...refreshed.project.inputMap, { action: 'Ability1', kind: 'button', keys: ['ShiftLeft', 'ShiftRight'] }] } }], 'module-scaffold');
    }
    setSelectedPath(packageFiles.find((file) => file.path.endsWith('.system.ts'))?.path || packageFiles[0].path);
  };
  const editorLanguage = selected?.language === 'typescript' ? 'typescript' : 'json';
  return <div className="typescript-workspace"><div className="script-list"><div className="workspace-subheading"><span>Project source</span><button type="button" onClick={createPackage} title="Create a complete module, mechanic, system, prefab, and deterministic specification"><Icon name="add" size={13}/></button></div><div className="source-tree">{files.map((file) => { const errors = (current?.validation.moduleIssues || []).filter((entry) => entry.path === file.path && entry.severity === 'error').length; return <button type="button" key={file.path} className={selected?.path === file.path ? 'active' : ''} onClick={() => setSelectedPath(file.path)} title={file.path}><Icon name={file.kind === 'system' ? 'code' : file.kind === 'prefab' ? 'cube' : file.kind === 'test' ? 'test' : 'content'} size={13}/><span>{file.path.split('/').at(-1)}</span><small>{file.kind}</small><i className={errors ? 'error' : 'clean'}/></button>; })}</div>{!files.length && <div className="source-empty"><strong>No game modules yet</strong><span>Create a five-file mechanic package or let an external agent write the source tree.</span><button type="button" onClick={createPackage}>New mechanic package</button></div>}<div className="sandbox-policy"><Icon name="lock" size={14}/><strong>Capability sandbox</strong><span>Opaque iframe · disposable worker · 200 ms kill budget</span><code>no DOM / network / cookies</code><code>seeded random + fixed step</code><code>{current?.moduleSummary.modules.length || 0} modules · {current?.moduleSummary.systems.length || 0} systems</code></div></div><div className="monaco-wrap"><div className={`compile-bar ${diagnostics.some((entry) => entry.severity === 'error') ? 'failed' : compile?.valid ? 'passed' : ''}`}><span>{selected ? `${selected.path}${dirty ? ' · unsaved' : ''}` : 'Create a module package to begin'}</span><div className="compile-actions">{selected && <button type="button" onClick={() => deleteSourceFile(selected.path)} title="Delete this source file">Delete</button>}<button type="button" onClick={compileModules} disabled={!files.length}>Compile</button><button type="button" onClick={runMechanicTests} disabled={!files.length || compile?.valid === false}>Run specs{mechanicTests ? ` ${mechanicTests.passed}/${mechanicTests.passed + mechanicTests.failed}` : ''}</button><button type="button" className="primary-small" disabled={!dirty || saveStatus === 'saving'} onClick={() => selected && saveSourceFile(selected.path, draft, selected.enabled)}>{saveStatus === 'saving' ? 'Saving…' : 'Save file'}</button></div></div>{diagnostics.length > 0 && <div className="source-diagnostics">{diagnostics.slice(0, 4).map((entry, index) => <button type="button" key={`${entry.code}-${index}`} className={entry.severity}><strong>{entry.code}</strong><span>{entry.line ? `${entry.line}:${entry.column || 1} ` : ''}{entry.message}</span></button>)}</div>}{selected ? <Editor path={selected.path} height="100%" language={editorLanguage} theme="vs-dark" value={draft} onChange={(value) => setDraft(value || '')} onMount={async (_editor, monaco) => { try { const response = await fetch('/api/game-studio/contracts'); const contracts = await response.json(); if (contracts.runtimeTypeDeclarations) monaco.languages.typescript.typescriptDefaults.addExtraLib(contracts.runtimeTypeDeclarations, 'file:///lilly-engine-runtime.d.ts'); } catch (_error) {} }} options={{ minimap: { enabled: false }, fontSize: 12, fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace', padding: { top: 14 }, scrollBeyondLastLine: false, tabSize: 2, wordWrap: 'on', renderLineHighlight: 'line', automaticLayout: true }}/>: <div className="workspace-empty"><Icon name="code" size={28}/><strong>Agent-programmable game source</strong><span>Modules package mechanics, systems, prefabs, and tests into independently reviewable parts.</span><button type="button" onClick={createPackage}>Create first mechanic package</button></div>}</div></div>;
}

function ConsoleWorkspace() {
  const items = useStudioStore((state) => state.consoleItems);
  return <div className="console-workspace"><div className="console-toolbar"><button type="button">Clear</button><span>{items.length} messages</span><label><input type="checkbox" defaultChecked/>Auto-scroll</label></div><div className="console-lines">{items.map((item) => <div key={item.id} className={`console-line level-${item.level}`}><time>{new Date(item.timestamp).toLocaleTimeString([], { hour12: false })}</time><span className="console-level">{item.level}</span><code>{item.message}</code></div>)}</div></div>;
}

function TestsWorkspace() {
  const current = useStudioStore((state) => state.current);
  const playtest = useStudioStore((state) => state.latestPlaytest);
  const buildStatus = useStudioStore((state) => state.buildStatus);
  const runPlaytest = useStudioStore((state) => state.runPlaytest);
  const defaultTests = [
    { name: 'Project schema and components', status: current?.validation.projectIssues.length ? 'failed' : 'passed', details: `${current?.validation.projectIssues.length || 0} project issues` },
    { name: 'Blueprint validation', status: current?.validation.blueprintIssues.length ? 'failed' : 'passed', details: `${current?.project.blueprints.length || 0} graphs` },
    { name: 'Agent module architecture', status: current?.validation.moduleIssues.some((entry) => entry.severity === 'error') ? 'failed' : 'passed', details: `${current?.moduleSummary.modules.length || 0} modules · ${current?.moduleSummary.systems.length || 0} systems · ${current?.moduleSummary.tests.length || 0} specs` },
  ];
  const tests = playtest?.tests || defaultTests;
  return <div className="tests-workspace"><div className="test-summary"><div><span className="panel-kicker">Automated playtest</span><strong>{playtest ? (playtest.status === 'passed' ? 'All checks passed' : 'Release blockers found') : 'Ready to run'}</strong><small>{playtest ? `${tests.filter((test) => test.status === 'passed').length}/${tests.length} checks passed at r${current?.project.revision}` : 'Project, graphs, assets, controls, and simulation'}</small></div><button type="button" className="primary-small" onClick={runPlaytest} disabled={buildStatus === 'testing'}>{buildStatus === 'testing' ? 'Running 120 steps…' : 'Run playtest'}</button></div><div className="test-list">{tests.map((test) => <div key={test.name} className={`test-row ${test.status}`}><span className="test-status">{test.status === 'passed' ? '✓' : '!'}</span><div><strong>{test.name}</strong><small>{test.details}</small></div><span>{test.status}</span></div>)}</div></div>;
}

function BuildCard({ build }: { build: StudioBuild }) {
  const publish = useStudioStore((state) => state.publish);
  const [previewOpen, setPreviewOpen] = useState(false);
  return <div className="build-card"><div className="build-card-head"><div className={`build-state ${build.status}`}><span/>{build.status}</div><strong>r{build.projectRevision}</strong><code>{build.id.slice(0, 8)}</code><time>{new Date(build.createdAt).toLocaleString()}</time></div><div className="build-proof">{build.tests.map((test) => <span key={test.name} className={test.status}>{test.status === 'passed' ? '✓' : '!'} {test.name}</span>)}</div><div className="build-actions"><button type="button" onClick={() => setPreviewOpen((value) => !value)}><Icon name="play" size={13}/>{previewOpen ? 'Close preview' : 'Private preview'}</button><button type="button" className="primary-small" onClick={() => publish(build)} disabled={build.status === 'published'}><Icon name="publish" size={13}/>{build.status === 'published' ? 'Published' : 'Publish HTTPS'}</button>{build.publicUrl && <a href={build.publicUrl} target="_blank" rel="noreferrer">{build.publicUrl}</a>}</div>{previewOpen && <div className="build-preview-wrap"><iframe src={build.previewUrl} title={`Private preview for revision ${build.projectRevision}`} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"/></div>}</div>;
}

function BuildWorkspace() {
  const current = useStudioStore((state) => state.current);
  const buildStatus = useStudioStore((state) => state.buildStatus);
  const build = useStudioStore((state) => state.build);
  const rollback = useStudioStore((state) => state.rollback);
  return <div className="build-workspace"><div className="build-summary"><div><span className="panel-kicker">Immutable artifacts</span><strong>{current?.builds.length || 0} builds</strong><small>Each build is tied to one saved revision and tested Graph IR.</small></div><div className="build-summary-actions">{(current?.project.revision || 1) > 1 && <button type="button" onClick={() => rollback(1)}>Rollback to r1</button>}<button type="button" className="primary-small" onClick={build} disabled={buildStatus === 'building'}>{buildStatus === 'building' ? 'Building fixed bundle…' : 'Build current revision'}</button></div></div><div className="build-list">{current?.builds.map((entry) => <BuildCard key={entry.id} build={entry}/>) || null}{!current?.builds.length && <div className="workspace-empty"><Icon name="build" size={26}/><strong>No builds yet</strong><span>Run a playtest, then create an immutable private preview.</span></div>}</div></div>;
}

export function BottomWorkspace() {
  const active = useStudioStore((state) => state.bottomTab);
  const setActive = useStudioStore((state) => state.setBottomTab);
  const current = useStudioStore((state) => state.current);
  const consoleCount = useStudioStore((state) => state.consoleItems.filter((item) => item.level === 'error').length);
  return <section className="bottom-workspace studio-panel"><div className="workspace-tabs">{tabs.map((tab) => <button type="button" key={tab.id} className={active === tab.id ? 'active' : ''} onClick={() => setActive(tab.id)}><Icon name={tab.icon} size={14}/><span>{tab.label}</span>{tab.id === 'console' && consoleCount > 0 && <em>{consoleCount}</em>}{tab.id === 'blueprints' && current && <small>{current.project.blueprints.length}</small>}{tab.id === 'typescript' && current && <small>{current.moduleSummary.systems.length}</small>}</button>)}<div className="workspace-tab-spacer"/><span className={`engine-health ${current?.validation.valid ? 'healthy' : 'invalid'}`}><i/>{current?.validation.valid ? 'Engine ready' : 'Validation blocked'}</span></div><div className="workspace-content">{active === 'content' && <ContentBrowser/>}{active === 'blueprints' && <BlueprintEditor/>}{active === 'typescript' && <ModuleWorkspace/>}{active === 'console' && <ConsoleWorkspace/>}{active === 'tests' && <TestsWorkspace/>}{active === 'build' && <BuildWorkspace/>}</div></section>;
}
