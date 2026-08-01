import { useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import type { BottomTab, StudioBuild } from '../types';
import { currentScene, useStudioStore } from '../store';
import { BlueprintEditor } from './BlueprintEditor';
import { Icon } from './Icon';

const tabs: Array<{ id: BottomTab; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { id: 'content', label: 'Content Browser', icon: 'content' },
  { id: 'blueprints', label: 'Blueprints', icon: 'blueprint' },
  { id: 'typescript', label: 'TypeScript', icon: 'code' },
  { id: 'console', label: 'Console', icon: 'console' },
  { id: 'tests', label: 'Tests', icon: 'test' },
  { id: 'build', label: 'Build Output', icon: 'build' },
];

function ContentBrowser() {
  const current = useStudioStore((state) => state.current);
  const importProject = useStudioStore((state) => state.importProject);
  const scene = currentScene(current);
  const [query, setQuery] = useState('');
  const items = useMemo(() => [
    ...(current?.project.assets || []).map((asset) => ({ id: asset.id, name: asset.name, type: asset.type, kind: 'asset' })),
    ...(scene?.entities.filter((entity) => entity.tags.includes('pickup') || entity.tags.includes('player')).map((entity) => ({ id: entity.id, name: entity.name, type: entity.tags.includes('player') ? 'Player prefab' : 'Collectible prefab', kind: 'prefab' })) || []),
    ...(current?.project.blueprints.map((graph) => ({ id: graph.id, name: graph.name, type: `${graph.nodes.length} nodes`, kind: 'blueprint' })) || []),
  ].filter((item) => item.name.toLowerCase().includes(query.toLowerCase())), [current, scene, query]);
  return <div className="content-browser"><div className="content-sidebar"><button type="button" className="active">All Content</button><button type="button">Assets</button><button type="button">Prefabs</button><button type="button">Scenes</button><button type="button">Audio</button></div><div className="content-main"><div className="content-actions"><div className="search-field compact"><Icon name="search" size={13}/><input placeholder="Filter content" value={query} onChange={(event) => setQuery(event.target.value)}/></div><input id="game-studio-import" className="visually-hidden" type="file" accept=".json,.html,text/html,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) importProject(file); event.currentTarget.value = ''; }}/><button type="button" onClick={() => document.getElementById('game-studio-import')?.click()} title="Import a LillyProject/v1 JSON file or compatible HTML/Three.js bundle"><Icon name="add" size={13}/>Import project</button></div><div className="asset-grid">{items.map((item) => <button type="button" className="asset-card" key={item.id}><div className={`asset-thumb kind-${item.kind}`}><Icon name={item.kind === 'blueprint' ? 'blueprint' : item.kind === 'prefab' ? 'cube' : 'content'} size={24}/></div><strong>{item.name}</strong><small>{item.type}</small></button>)}{!items.length && <div className="workspace-empty"><strong>No matching content</strong><span>Import a GLB, texture, or audio file.</span></div>}</div></div></div>;
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
  return <section className="bottom-workspace studio-panel"><div className="workspace-tabs">{tabs.map((tab) => <button type="button" key={tab.id} className={active === tab.id ? 'active' : ''} onClick={() => setActive(tab.id)}><Icon name={tab.icon} size={14}/><span>{tab.label}</span>{tab.id === 'console' && consoleCount > 0 && <em>{consoleCount}</em>}{tab.id === 'blueprints' && current && <small>{current.project.blueprints.length}</small>}</button>)}<div className="workspace-tab-spacer"/><span className={`engine-health ${current?.validation.valid ? 'healthy' : 'invalid'}`}><i/>{current?.validation.valid ? 'Engine ready' : 'Validation blocked'}</span></div><div className="workspace-content">{active === 'content' && <ContentBrowser/>}{active === 'blueprints' && <BlueprintEditor/>}{active === 'typescript' && <TypeScriptWorkspace/>}{active === 'console' && <ConsoleWorkspace/>}{active === 'tests' && <TestsWorkspace/>}{active === 'build' && <BuildWorkspace/>}</div></section>;
}
