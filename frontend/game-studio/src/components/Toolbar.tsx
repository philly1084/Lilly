import { useState } from 'react';
import { Icon } from './Icon';
import { useStudioStore } from '../store';

function ToolButton({ label, icon, active, disabled, onClick, shortcut }: { label: string; icon: Parameters<typeof Icon>[0]['name']; active?: boolean; disabled?: boolean; onClick(): void; shortcut?: string }) {
  return <button className={`tool-button${active ? ' is-active' : ''}`} type="button" onClick={onClick} disabled={disabled} title={`${label}${shortcut ? ` (${shortcut})` : ''}`}><Icon name={icon}/><span className="tool-label">{label}</span></button>;
}

export function Toolbar({ onCommandPalette }: { onCommandPalette(): void }) {
  const [projectOpen, setProjectOpen] = useState(false);
  const {
    current,
    projects,
    saveStatus,
    playState,
    transformMode,
    undoStack,
    redoStack,
    buildStatus,
    openProject,
    undo,
    redo,
    setPlayState,
    step,
    setTransformMode,
    build,
    setAiOpen,
  } = useStudioStore();
  const project = current?.project;
  return <header className="studio-toolbar">
    <div className="brand-lockup"><div className="brand-mark">L</div><div><strong>Lilly</strong><span>Game Studio</span></div></div>
    <div className="toolbar-divider" />
    <div className="project-switcher">
      <button type="button" className="project-button" onClick={() => setProjectOpen((open) => !open)}><Icon name="project"/><span><strong>{project?.name || 'No project'}</strong><small>{project ? `r${project.revision} · ${project.engineVersion}` : 'Create a project'}</small></span><span className="chevron">⌄</span></button>
      {projectOpen && <div className="project-menu surface-popover">
        <div className="menu-label">Recent projects</div>
        {projects.map((entry) => <button type="button" key={entry.id} className={entry.id === project?.id ? 'selected' : ''} onClick={() => { openProject(entry.id); setProjectOpen(false); }}><span>{entry.name}</span><small>r{entry.revision}</small></button>)}
      </div>}
    </div>
    <div className={`save-indicator state-${saveStatus}`}><span className="status-dot"/><span>{saveStatus === 'saved' ? 'All changes saved' : saveStatus === 'saving' ? 'Saving revision…' : saveStatus === 'conflict' ? 'Revision conflict' : 'Save failed'}</span></div>
    <div className="toolbar-spacer" />
    <div className="toolbar-group compact"><ToolButton label="Undo" icon="undo" shortcut="Ctrl+Z" disabled={!undoStack.length} onClick={undo}/><ToolButton label="Redo" icon="redo" shortcut="Ctrl+Shift+Z" disabled={!redoStack.length} onClick={redo}/></div>
    <div className="toolbar-group transform-tools"><ToolButton label="Move" icon="translate" shortcut="W" active={transformMode === 'translate'} onClick={() => setTransformMode('translate')}/><ToolButton label="Rotate" icon="rotate" shortcut="E" active={transformMode === 'rotate'} onClick={() => setTransformMode('rotate')}/><ToolButton label="Scale" icon="scale" shortcut="R" active={transformMode === 'scale'} onClick={() => setTransformMode('scale')}/></div>
    <div className="play-controls">
      {playState === 'playing'
        ? <ToolButton label="Pause" icon="pause" shortcut="F6" active onClick={() => setPlayState('paused')}/>
        : <ToolButton label="Play" icon="play" shortcut="F6" active={playState === 'paused'} onClick={() => setPlayState('playing')}/>
      }
      <ToolButton label="Step" icon="step" disabled={playState === 'editing'} onClick={step}/>
      {playState !== 'editing' && <button type="button" className="stop-button" onClick={() => setPlayState('editing')} title="Stop play mode"><span/></button>}
    </div>
    <div className="toolbar-spacer" />
    <ToolButton label="Create" icon="spark" onClick={() => setAiOpen(true)}/>
    <ToolButton label={buildStatus === 'building' ? 'Building…' : 'Build'} icon="build" disabled={buildStatus === 'building'} onClick={() => build()}/>
    <button className="command-button" type="button" onClick={onCommandPalette} title="Command palette (Ctrl+K)"><Icon name="command"/><kbd>⌘ K</kbd></button>
  </header>;
}
