import { useEffect, useMemo, useState } from 'react';
import { AiPanel } from './components/AiPanel';
import { BottomWorkspace } from './components/BottomWorkspace';
import { CommandPalette } from './components/CommandPalette';
import { Hierarchy } from './components/Hierarchy';
import { Icon } from './components/Icon';
import { Inspector } from './components/Inspector';
import { MobileCreator } from './components/LevelCreator';
import { Toolbar } from './components/Toolbar';
import { Viewport } from './components/Viewport';
import { useStudioStore } from './store';

type Layout = { left: number; right: number; bottom: number; leftOpen: boolean; rightOpen: boolean; bottomOpen: boolean };
const defaultLayout: Layout = { left: 260, right: 310, bottom: 300, leftOpen: true, rightOpen: true, bottomOpen: true };

function loadLayout(): Layout {
  try { return { ...defaultLayout, ...JSON.parse(localStorage.getItem('lilly-game-studio:layout') || '{}') }; } catch (_error) { return defaultLayout; }
}

function ResizeHandle({ direction, onResize }: { direction: 'left' | 'right' | 'bottom'; onResize(delta: number): void }) {
  return <div className={`resize-handle resize-${direction}`} onPointerDown={(event) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = direction === 'bottom' ? event.clientY : event.clientX;
    const move = (moveEvent: PointerEvent) => onResize((direction === 'bottom' ? moveEvent.clientY : moveEvent.clientX) - start);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }}/>
}

function LoadingState() {
  return <div className="full-state loading-state"><div className="engine-loader"><div className="engine-orbit"><span/><span/><span/></div><div><span className="panel-kicker">Lilly Engine</span><strong>Loading Game Studio</strong><small>Opening project contracts and renderer…</small></div></div></div>;
}

function EmptyState() {
  const createProject = useStudioStore((state) => state.createProject);
  const [name, setName] = useState('My Lilly Game');
  const [brief, setBrief] = useState('A winding neon ruin with glowing energy cores, fair pulse traps, strong landmarks, and a final exit beacon.');
  const create = () => {
    if (name.trim() && brief.trim()) createProject(name.trim(), brief.trim());
  };
  return <div className="full-state onboarding-state">
    <div className="onboarding-art"><div className="art-grid"/><div className="art-player"/><div className="art-shard one"/><div className="art-shard two"/><div className="art-shard three"/></div>
    <div className="onboarding-copy">
      <div className="brand-mark large">L</div>
      <span className="panel-kicker">Lilly AI Game Studio</span>
      <h1>Describe a world. Play it.</h1>
      <p>Lilly turns one idea into a saved, editable level with a real route, objectives, hazards, landmarks, touch controls, and a deterministic seed.</p>
      <label>Game name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>What should the level feel like?<textarea value={brief} onChange={(event) => setBrief(event.target.value)} rows={3} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) create(); }}/></label>
      <button type="button" onClick={create} disabled={!name.trim() || !brief.trim()}><Icon name="spark"/>Create playable world</button>
      <div className="onboarding-proof"><span>Seeded level design</span><span>Typed Blueprints</span><span>Phone authoring</span><span>HTTPS publishing</span></div>
    </div>
  </div>;
}

function FailureState({ disconnected = false }: { disconnected?: boolean }) {
  const initialize = useStudioStore((state) => state.initialize);
  const error = useStudioStore((state) => state.error);
  return <div className="full-state failure-state"><div className="failure-card"><span className="failure-icon">{disconnected ? '↯' : '!'}</span><span className="panel-kicker">{disconnected ? 'Backend disconnected' : 'Editor could not open'}</span><h1>{disconnected ? 'Lilly Engine is offline' : 'Game Studio hit an error'}</h1><p>{error}</p><button type="button" onClick={initialize}>Retry connection</button><small>No project data was overwritten.</small></div></div>;
}

export default function App() {
  const status = useStudioStore((state) => state.status);
  const current = useStudioStore((state) => state.current);
  const initialize = useStudioStore((state) => state.initialize);
  const log = useStudioStore((state) => state.log);
  const [layout, setLayout] = useState(loadLayout);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => { initialize(); }, [initialize]);
  useEffect(() => { localStorage.setItem('lilly-game-studio:layout', JSON.stringify(layout)); }, [layout]);
  useEffect(() => {
    if (!current?.project.id) return;
    const events = new EventSource(`/api/game-studio/projects/${encodeURIComponent(current.project.id)}/events`);
    events.addEventListener('build.completed', (event) => { const payload = JSON.parse((event as MessageEvent).data); log('success', `Build event: ${payload.payload?.id?.slice(0, 8)} is ready`); });
    events.addEventListener('publish.queued', () => log('info', 'Publish entered the managed-app deployment lane'));
    events.onerror = () => log('warning', 'Live project event stream disconnected; saved API operations remain available');
    return () => events.close();
  }, [current?.project.id, log]);
  useEffect(() => {
    if (!current?.project.id) return;
    const projectId = current.project.id;
    const onStorageMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.schema !== 'LillyPlayerStorage/v1' || message.projectId !== projectId || !event.source) return;
      const storageKey = `lilly:${projectId}:save`;
      const respond = (payload: Record<string, unknown>) => (event.source as WindowProxy).postMessage({
        schema: 'LillyPlayerStorage/v1',
        projectId,
        requestId: message.requestId,
        ...payload,
      }, { targetOrigin: '*' });
      if (message.type === 'save') {
        try {
          const serialized = JSON.stringify(message.state || null);
          if (serialized.length > 64 * 1024) throw new Error('Save state exceeds 64 KiB');
          localStorage.setItem(storageKey, serialized);
          respond({ type: 'save-result', ok: true });
        } catch (_error) {
          respond({ type: 'save-result', ok: false });
        }
      }
      if (message.type === 'load') {
        try {
          const stored = localStorage.getItem(storageKey);
          respond({ type: 'load-result', ok: true, state: stored ? JSON.parse(stored) : null });
        } catch (_error) {
          respond({ type: 'load-result', ok: false, state: null });
        }
      }
    };
    window.addEventListener('message', onStorageMessage);
    return () => window.removeEventListener('message', onStorageMessage);
  }, [current?.project.id]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(true); }
      if (event.key === 'Escape') setPaletteOpen(false);
      if (event.key === 'F6') { event.preventDefault(); const state = useStudioStore.getState(); state.setPlayState(state.playState === 'playing' ? 'paused' : 'playing'); }
      if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? useStudioStore.getState().redo() : useStudioStore.getState().undo(); }
      if (modifier && event.key.toLowerCase() === 'b') { event.preventDefault(); useStudioStore.getState().build(); }
      if (!modifier && !/input|textarea/i.test((event.target as HTMLElement)?.tagName || '')) {
        if (event.key.toLowerCase() === 'w') useStudioStore.getState().setTransformMode('translate');
        if (event.key.toLowerCase() === 'e') useStudioStore.getState().setTransformMode('rotate');
        if (event.key.toLowerCase() === 'r' && useStudioStore.getState().playState === 'editing') useStudioStore.getState().setTransformMode('scale');
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, []);

  const gridStyle = useMemo(() => ({
    '--left-panel': `${layout.leftOpen ? layout.left : 0}px`,
    '--right-panel': `${layout.rightOpen ? layout.right : 0}px`,
    '--bottom-panel': `${layout.bottomOpen ? layout.bottom : 34}px`,
  }) as React.CSSProperties, [layout]);

  if (status === 'loading') return <LoadingState/>;
  if (status === 'empty') return <EmptyState/>;
  if (status === 'disconnected') return <FailureState disconnected/>;
  if (status === 'error' || !current) return <FailureState/>;

  return <div className="studio-app" style={gridStyle}>
    <Toolbar onCommandPalette={() => setPaletteOpen(true)}/>
    <div className="studio-grid">
      {layout.leftOpen && <Hierarchy/>}
      {layout.leftOpen && <ResizeHandle direction="left" onResize={(delta) => setLayout((currentLayout) => ({ ...currentLayout, left: Math.max(200, Math.min(420, currentLayout.left + delta)) }))}/>}
      <Viewport/>
      {layout.rightOpen && <ResizeHandle direction="right" onResize={(delta) => setLayout((currentLayout) => ({ ...currentLayout, right: Math.max(250, Math.min(480, currentLayout.right - delta)) }))}/>}
      {layout.rightOpen && <Inspector/>}
      {layout.bottomOpen && <ResizeHandle direction="bottom" onResize={(delta) => setLayout((currentLayout) => ({ ...currentLayout, bottom: Math.max(180, Math.min(520, currentLayout.bottom - delta)) }))}/>}
      <BottomWorkspace/>
      <div className="dock-controls"><button type="button" className={!layout.leftOpen ? 'collapsed' : ''} onClick={() => setLayout((value) => ({ ...value, leftOpen: !value.leftOpen }))} title="Toggle Hierarchy">H</button><button type="button" className={!layout.bottomOpen ? 'collapsed' : ''} onClick={() => setLayout((value) => ({ ...value, bottomOpen: !value.bottomOpen }))} title="Toggle Workspace">W</button><button type="button" className={!layout.rightOpen ? 'collapsed' : ''} onClick={() => setLayout((value) => ({ ...value, rightOpen: !value.rightOpen }))} title="Toggle Inspector">I</button></div>
    </div>
    <MobileCreator/>
    <AiPanel/>
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)}/>
  </div>;
}
